import contextlib
import io
import itertools
import json
import os
import sys
import uuid
from collections import OrderedDict

WORKER_ROOT = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ROOT = os.path.dirname(WORKER_ROOT)
APP_ROOT = os.path.dirname(RUNTIME_ROOT)

def prepare_engine():
    # Prefer the offline dependencies shipped alongside the application.
    bundled = os.path.join(RUNTIME_ROOT, 'dependencies')
    if os.path.isdir(bundled):
        sys.path.insert(0, bundled)
        try:
            import faster_whisper
            return faster_whisper
        except ImportError as exc:
            raise RuntimeError('离线识别组件不完整，请重新解压完整安装包。') from exc
    root = os.environ.get('DONOTE_VIDEO_DEPS')
    if not root:
        raise RuntimeError('缺少识别组件目录，请使用新版 DoNote 启动。')
    os.makedirs(root, exist_ok=True)
    marker = os.path.join(root, 'active.txt')
    if os.path.isfile(marker):
        with open(marker, encoding='ascii') as f:
            name = f.read().strip()
        if len(name) == 32 and all(c in '0123456789abcdef' for c in name):
            sys.path.insert(0, os.path.join(root, name))
            try:
                import faster_whisper
                return faster_whisper
            except ImportError:
                sys.path.pop(0)
    target = os.path.join(root, uuid.uuid4().hex)
    os.makedirs(target)
    from pip._internal.cli.main import main as pip_main
    # pip logs go to stderr so stdout remains a single JSON result.
    with contextlib.redirect_stdout(sys.stderr):
        code = pip_main(['install', '--disable-pip-version-check', '--no-input', '--target', target,
                         'faster-whisper==1.2.1', 'huggingface-hub==0.36.2', 'av<19'])
    if code != 0:
        raise RuntimeError('自动安装识别组件失败，请检查网络后重试。')
    sys.path.insert(0, target)
    import faster_whisper
    with open(marker, 'w', encoding='ascii') as f:
        f.write(os.path.basename(target))
    return faster_whisper

def local_model_path(name):
    # A manually downloaded official CTranslate2 model takes priority over Hub downloads.
    sizes = {'base': 145217532, 'small': 483546902,
             'large-v3-turbo': 1617884929, 'large-v3': 3087284237}
    if name not in sizes:
        raise RuntimeError('不支持的识别模型。')
    model_root = os.path.join(APP_ROOT, 'models', 'asr')
    folder = os.path.join(model_root, name)
    legacy = os.path.join(APP_ROOT, 'models', name)
    if not os.path.isdir(folder) and os.path.isdir(legacy):
        # Preserve existing downloads while moving model packs out of the
        # cluttered models root. If writes are unavailable, keep using legacy.
        try:
            os.makedirs(model_root, exist_ok=True)
            os.replace(legacy, folder)
        except OSError:
            folder = legacy
    if not os.path.isdir(folder):
        return name
    required = ['config.json', 'tokenizer.json', 'model.bin']
    if name in ('large-v3', 'large-v3-turbo'):
        required.append('preprocessor_config.json')
    missing = [f for f in required if not os.path.isfile(os.path.join(folder, f))]
    if not (os.path.isfile(os.path.join(folder, 'vocabulary.txt')) or os.path.isfile(os.path.join(folder, 'vocabulary.json'))):
        missing.append('vocabulary.txt 或 vocabulary.json')
    if missing:
        raise RuntimeError('模型目录不完整：' + folder + '；缺少 ' + '、'.join(missing))
    if os.path.getsize(os.path.join(folder, 'model.bin')) != sizes[name]:
        raise RuntimeError('模型权重大小不正确，文件可能未下载完整：' + os.path.join(folder, 'model.bin') + '；应为 ' + str(sizes[name]) + ' 字节。')
    return folder

def notify(kind, **fields):
    message = {'type': 'video-transcribe-' + kind, 'id': request_id, **fields}
    print('DONOTE_PROGRESS:' + json.dumps(message, ensure_ascii=False), file=sys.stderr, flush=True)

def progress(status, percent=None):
    notify('progress', status=status, percent=percent)


class VideoBlobReader(io.RawIOBase):
    """Seekable view of the attachment; only requested bytes cross the bridge."""
    block_size = 1024 * 1024
    max_blocks = 6

    def __init__(self, size):
        self.size = size
        self.position = 0
        self.blocks = OrderedDict()

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        anchor = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        position = anchor + offset
        if position < 0:
            raise OSError('无效的视频位置。')
        self.position = position
        return position

    def readinto(self, buffer):
        if self.position >= self.size:
            return 0
        start = self.position - self.position % self.block_size
        chunk = self.blocks.get(start)
        if chunk is None:
            length = min(self.block_size, self.size - start)
            notify('range-request', offset=start, length=length)
            chunk = sys.stdin.buffer.read(length)
            if len(chunk) != length:
                raise OSError('无法读取请求的视频数据。')
            self.blocks[start] = chunk
            if len(self.blocks) > self.max_blocks:
                self.blocks.popitem(last=False)
        else:
            self.blocks.move_to_end(start)
        index = self.position - start
        count = min(len(buffer), len(chunk) - index)
        buffer[:count] = chunk[index:index + count]
        self.position += count
        return count


def cut_near_silence(buffer, limit, rate, np):
    window = rate // 5
    for cut in range(limit, limit - 4 * rate, -rate // 10):
        tail = buffer[cut - window:cut].astype(np.float32)
        if np.mean(tail * tail) < 300 ** 2:
            return cut
    return limit


def audio_windows(container, audio, av, np):
    """Decode bounded windows, giving the first few seconds priority."""
    rate = 16000
    first, steady = 16 * rate, 48 * rate
    overlap = int(1.5 * rate)
    limit, offset = first, 0
    buffer = np.empty(steady, dtype=np.int16)
    used = 0
    resampler = av.AudioResampler(format='s16', layout='mono', rate=rate)
    frames = container.decode(audio)
    for frame in itertools.chain(frames, (None,)):
        if frame is not None:
            frame.pts = None
        for resampled in resampler.resample(frame):
            samples = resampled.to_ndarray().reshape(-1)
            cursor = 0
            while cursor < samples.size:
                count = min(limit - used, samples.size - cursor)
                buffer[used:used + count] = samples[cursor:cursor + count]
                used += count
                cursor += count
                if used == limit:
                    cut = cut_near_silence(buffer, used, rate, np)
                    yield offset / rate, buffer[:cut].astype(np.float32) / 32768.0
                    advance = cut - overlap
                    retained = used - advance
                    buffer[:retained] = buffer[advance:used].copy()
                    offset += advance
                    used, limit = retained, steady
    if used > (overlap if offset else 0):
        yield offset / rate, buffer[:used].astype(np.float32) / 32768.0


def recognize(video, model):
    # The bundled Windows Python uses an isolated _pth and omits the script directory.
    sys.path.insert(0, WORKER_ROOT)
    from transcript_utils import iter_merged_transcript_segments

    selected = local_model_path(model)
    progress('正在加载本地模型…' if selected != model else '正在准备识别模型；首次使用该模型需要联网下载…')
    whisper = prepare_engine()
    import av
    import numpy as np

    threads = max(2, min(8, (os.cpu_count() or 4) // 2))
    engine = whisper.WhisperModel(selected, device='cpu', compute_type='int8', cpu_threads=threads)
    fast = model != 'large-v3'
    inference = whisper.BatchedInferencePipeline(model=engine) if fast else engine
    if fast:
        options = dict(beam_size=5, batch_size=4, chunk_length=14, without_timestamps=False,
                       vad_parameters=dict(min_silence_duration_ms=350))
    else:
        options = dict(beam_size=5)
    progress('正在读取音轨，识别到的字幕会边生成边显示…')
    with av.open(video, mode='r') as container:
        if not container.streams.audio:
            return 0
        audio = container.streams.audio[0]
        duration = (container.duration or 0) / av.time_base
        video_start = (container.start_time or 0) / av.time_base
        audio_start = max(0, float(audio.start_time * audio.time_base) - video_start) if audio.start_time is not None and audio.time_base else 0
        count, covered = 0, 0.0
        for offset, samples in audio_windows(container, audio, av, np):
            segments, _ = inference.transcribe(samples, language='en', vad_filter=True, **options)
            window_end = offset + samples.size / 16000
            def cues():
                for segment in segments:
                    end = min(window_end, offset + segment.end)
                    start = max(covered, offset + segment.start)
                    if end > start and end - covered > 0.08 and segment.text.strip():
                        yield {'start': audio_start + start, 'end': audio_start + end, 'en': segment.text}
            rows = list(iter_merged_transcript_segments(cues()))
            if rows:
                count += len(rows)
                covered = rows[-1]['end'] - audio_start
                for index in range(0, len(rows), 20):
                    notify('segments', segments=rows[index:index + 20])
            percent = min(99, int((audio_start + window_end) / duration * 100)) if duration else None
            progress('正在识别，已显示 ' + str(count) + ' 条英文字幕…', percent)
        return count


if __name__ == '__main__':
    request_id = sys.argv[3] if len(sys.argv) > 3 else ''
    try:
        video, model = sys.argv[1:3]
        ranged = video == '-'
        source = io.BufferedReader(VideoBlobReader(int(sys.argv[4]))) if ranged else video
        count = recognize(source, model)
        result = {'type': 'video-transcribe-result', 'id': request_id, 'count': count}
    except Exception as error:
        result = {'type': 'video-transcribe-result', 'id': request_id, 'error': '识别失败：' + str(error)[:500]}
    print(json.dumps(result, ensure_ascii=False), flush=True)
