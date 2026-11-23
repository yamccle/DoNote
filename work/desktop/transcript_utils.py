import re


SENTENCE_END = re.compile(r'[.!?。！？][\"\'”’）)]*$')


def _text(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _join(left, right):
    left, right = _text(left), _text(right)
    if not left:
        return right
    if not right:
        return left
    return left + ('' if right[0] in '.,;:!?%)]}，。；：！？' else ' ') + right


def _should_merge(previous, current):
    left, right = _text(previous.get('en')), _text(current.get('en'))
    if not left or not right:
        return False
    start, end = float(previous.get('start', 0)), float(current.get('end', 0))
    gap = float(current.get('start', 0)) - float(previous.get('end', 0))
    words = right.split()
    if gap > 1.25 or end - start > 15 or len(left) + len(right) > 240:
        return False
    if SENTENCE_END.search(left):
        # A later tiny fragment can still belong to the same sentence when it
        # begins like an unfinished clause rather than a new utterance.
        return right[0].islower() and len(words) <= 3
    if left[-1] in ',;:-—':
        return len(words) <= 12
    return right[0].islower() or right[0].isdigit() or len(words) <= 5


def iter_merged_transcript_segments(segments):
    """Yield finished cues while retaining the last merge candidate."""
    previous = None
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        text = _text(segment.get('en'))
        if not text:
            continue
        current = {
            'start': round(float(segment.get('start', 0)), 3),
            'end': round(float(segment.get('end', 0)), 3),
            'en': text,
            'zh': str(segment.get('zh') or ''),
        }
        if previous is not None and _should_merge(previous, current):
            previous['end'] = max(previous['end'], current['end'])
            previous['en'] = _join(previous['en'], current['en'])
        else:
            if previous is not None:
                yield previous
            previous = current
    if previous is not None:
        yield previous


def merge_transcript_segments(segments):
    """Merge ASR fragments that are not sentence boundaries."""
    return list(iter_merged_transcript_segments(segments))

