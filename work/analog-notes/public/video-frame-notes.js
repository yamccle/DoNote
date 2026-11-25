'use strict';

const VIDEO_FRAME_NOTE_LIMIT = 100;
const VIDEO_FRAME_IMAGE_LIMIT = 350000;
let videoFrameSaveQueue = Promise.resolve();

function videoFrameNotesKey(profileId, fileId) {
  return 'video-frame-notes/' + profileId + '/' + fileId;
}

function checkedVideoFrameNotes(value) {
  if (!Array.isArray(value) || value.length > VIDEO_FRAME_NOTE_LIMIT) {
    throw new Error('视频批注内容无效。');
  }
  const ids = new Set();
  return value.map(item => {
    const {id, time, text, image, focus} = item || {};
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || ids.has(id) ||
        !Number.isFinite(time) || time < 0 ||
        typeof text !== 'string' || text.length > 2000 ||
        typeof image !== 'string' || image.length > VIDEO_FRAME_IMAGE_LIMIT ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ||
        (focus != null && !validVideoFrameFocus(focus))) {
      throw new Error('视频批注内容无效。');
    }
    ids.add(id);
    return {id, time, text, image, focus: focus ?? null};
  });
}

function validVideoFrameFocus(focus) {
  return Array.isArray(focus) && focus.length === 4 &&
    focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    focus[0] < focus[2] && focus[1] < focus[3];
}

async function fileVideoFrameNotes(profileId, file) {
  const store = database.transaction('workspace').objectStore('workspace');
  const stored = await reqResult(store.get(videoFrameNotesKey(profileId, file.id)));
  return checkedVideoFrameNotes(stored ?? file.videoFrameNotes ?? []);
}

function captureVideoFrame(video) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking || !video.videoWidth || !video.videoHeight) {
    throw new Error('画面尚未就绪。请等当前帧加载后再截图。');
  }
  video.pause();
  const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d', {alpha: false}).drawImage(video, 0, 0, canvas.width, canvas.height);
  let image = canvas.toDataURL('image/jpeg', 0.82);
  if (image.length > VIDEO_FRAME_IMAGE_LIMIT) image = canvas.toDataURL('image/jpeg', 0.6);
  if (!image.startsWith('data:image/jpeg;base64,') || image.length > VIDEO_FRAME_IMAGE_LIMIT) {
    throw new Error('当前画面无法生成截图。');
  }
  return {id: crypto.randomUUID(), time: video.currentTime, image, text: '', focus: null};
}

function mountVideoFrameNotes(session, video, hint, content) {
  const {signal} = session.controller;
  const layout = document.createElement('section');
  layout.className = 'video-review-layout';
  const player = document.createElement('div');
  player.className = 'video-review-player';
  player.append(video, hint);
  const panel = document.createElement('aside');
  panel.className = 'video-frame-notes';
  panel.setAttribute('aria-label', '定格批注');
  panel.innerHTML = `
    <header class="video-frame-heading">
      <h3>定格批注</h3>
      <button type="button" class="primary" data-frame-capture>截图批注</button>
    </header>
    <p class="video-frame-status" role="status"></p>
    <p class="video-frame-empty">暂停或播放时均可截图，保存后可跳回对应时间。</p>
    <form class="video-frame-editor" hidden>
      <div class="video-frame-editor-bar">
        <time></time>
        <small>拖动框选重点</small>
        <button type="button" class="secondary" data-focus-clear hidden>清除框选</button>
      </div>
      <div class="video-frame-image" title="在截图上拖动，框选重点">
        <img alt="批注截图" draggable="false">
        <span class="video-frame-focus" aria-hidden="true" hidden></span>
      </div>
      <label>批注 <textarea rows="3" maxlength="2000" placeholder="记下这个画面的重点"></textarea></label>
      <div class="video-frame-actions">
        <button type="button" class="secondary" data-frame-cancel>取消</button>
        <button type="submit" class="primary">保存批注</button>
      </div>
    </form>
    <ol class="video-frame-list"></ol>`;
  layout.append(player, panel);
  content.append(layout);

  const capture = panel.querySelector('[data-frame-capture]');
  const status = panel.querySelector('.video-frame-status');
  const empty = panel.querySelector('.video-frame-empty');
  const list = panel.querySelector('.video-frame-list');
  const form = panel.querySelector('form');
  const editorFrame = form.querySelector('.video-frame-image');
  const input = form.querySelector('textarea');
  const clear = form.querySelector('[data-focus-clear]');
  const cancel = form.querySelector('[data-frame-cancel]');
  const save = form.querySelector('[type="submit"]');
  const formatTime = seconds => {
    const whole = Math.floor(seconds);
    return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  };
  let notes = [], draft = null, gesture = null, busy = false;
  let loading = Boolean(session.ownerId);
  if (!session.ownerId) status.textContent = '将视频加入资料库后，即可保存定格批注。';

  function showFocus(frame, focus) {
    const box = frame.querySelector('.video-frame-focus');
    box.hidden = !focus;
    if (!focus) return;
    const [left, top, right, bottom] = focus;
    Object.assign(box.style, {
      left: left * 100 + '%',
      top: top * 100 + '%',
      width: (right - left) * 100 + '%',
      height: (bottom - top) * 100 + '%',
    });
  }

  function updateControls() {
    capture.disabled = busy || loading || !session.ownerId || !!draft ||
      video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth;
    cancel.disabled = save.disabled = input.disabled = clear.disabled = busy;
    for (const button of list.querySelectorAll('[data-frame-action]')) {
      button.disabled = busy || (!!draft && button.dataset.frameAction !== 'seek');
    }
  }

  function edit(note) {
    draft = {...note};
    form.hidden = false;
    status.textContent = '';
    form.querySelector('time').textContent = formatTime(note.time);
    editorFrame.querySelector('img').src = note.image;
    showFocus(editorFrame, note.focus);
    clear.hidden = !note.focus;
    input.value = note.text;
    empty.hidden = true;
    updateControls();
    input.focus();
  }

  function closeEditor() {
    draft = gesture = null;
    editorFrame.querySelector('img').removeAttribute('src');
    form.hidden = true;
    empty.hidden = notes.length > 0;
    updateControls();
  }

  function drawList() {
    const entries = [...notes].sort((a, b) => a.time - b.time);
    list.replaceChildren(...entries.map(note => {
      const row = document.createElement('li');
      row.dataset.frameId = note.id;
      row.innerHTML = `
        <button type="button" class="video-frame-image video-frame-thumbnail" data-frame-action="seek">
          <img alt="" loading="lazy"><span class="video-frame-focus" aria-hidden="true" hidden></span>
          <time></time>
        </button>
        <p class="video-frame-text"></p>
        <div class="video-frame-actions">
          <button type="button" class="secondary" data-frame-action="edit">编辑</button>
          <button type="button" class="secondary" data-frame-action="delete">删除</button>
        </div>`;
      const time = formatTime(note.time);
      const thumbnail = row.firstElementChild;
      thumbnail.title = '跳到 ' + time;
      thumbnail.setAttribute('aria-label', '跳到 ' + time);
      thumbnail.querySelector('img').src = note.image;
      thumbnail.querySelector('time').textContent = time;
      showFocus(thumbnail, note.focus);
      const text = row.querySelector('p');
      text.textContent = note.text;
      text.hidden = !note.text;
      return row;
    }));
    empty.hidden = !!draft || !!notes.length || loading || !session.ownerId;
    updateControls();
  }

  async function persist(updated, message) {
    busy = true;
    status.textContent = '正在保存…';
    updateControls();
    try {
      const key = videoFrameNotesKey(session.profileId, session.file.id);
      const operation = videoFrameSaveQueue.catch(() => {}).then(async () => {
        if (!await putWorkspaceForFile(session.profileId, session.file.id, key, checkedVideoFrameNotes(updated))) {
          throw new Error('视频已删除，无法保存批注。');
        }
      });
      videoFrameSaveQueue = operation;
      await operation;
      if (signal.aborted) return;
      notes = updated;
      closeEditor();
      drawList();
      status.textContent = message;
    } catch (error) {
      if (!signal.aborted) status.textContent = '保存失败。' + error.message;
    } finally {
      busy = false;
      if (!signal.aborted) updateControls();
    }
  }

  for (const event of ['loadeddata', 'seeking', 'seeked', 'emptied', 'error']) {
    video.addEventListener(event, updateControls, {signal});
  }
  capture.addEventListener('click', () => {
    if (notes.length >= VIDEO_FRAME_NOTE_LIMIT) {
      status.textContent = '此视频已有 ' + VIDEO_FRAME_NOTE_LIMIT + ' 条定格批注。';
      return;
    }
    try { edit(captureVideoFrame(video)); }
    catch (error) { status.textContent = error.message; }
  }, {signal});
  cancel.addEventListener('click', () => {
    closeEditor();
    if (!capture.disabled) capture.focus();
  }, {signal});
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !draft) return;
    const note = {...draft, text: input.value.trim()};
    const index = notes.findIndex(item => item.id === note.id);
    const updated = [...notes];
    if (index < 0) updated.push(note);
    else updated[index] = note;
    void persist(updated, '批注已保存');
  }, {signal});
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-frame-action]');
    if (!button) return;
    const note = notes.find(item => item.id === button.closest('li').dataset.frameId);
    if (!note) return;
    if (button.dataset.frameAction === 'seek') {
      if (video.readyState === HTMLMediaElement.HAVE_NOTHING || !Number.isFinite(video.duration)) {
        status.textContent = '请等视频加载后再跳转。';
        return;
      }
      video.pause();
      video.currentTime = Math.min(video.duration, note.time);
      player.scrollIntoView({block: 'nearest'});
    } else if (button.dataset.frameAction === 'edit') {
      edit(note);
    } else if (confirm('删除这条定格批注？')) {
      void persist(notes.filter(item => item.id !== note.id), '批注已删除');
    }
  }, {signal});

  function normalizedPoint(event) {
    const {left, top, width, height} = editorFrame.getBoundingClientRect();
    const bound = value => Math.min(1, Math.max(0, value));
    return [bound((event.clientX - left) / width), bound((event.clientY - top) / height)];
  }

  function focusRect(start, end) {
    return [Math.min(start[0], end[0]), Math.min(start[1], end[1]),
      Math.max(start[0], end[0]), Math.max(start[1], end[1])];
  }

  editorFrame.addEventListener('pointerdown', event => {
    if (busy || !draft || !event.isPrimary || event.button !== 0) return;
    gesture = {id: event.pointerId, point: normalizedPoint(event)};
    editorFrame.setPointerCapture(gesture.id);
  }, {signal});
  editorFrame.addEventListener('pointermove', event => {
    if (gesture?.id === event.pointerId) showFocus(editorFrame, focusRect(gesture.point, normalizedPoint(event)));
  }, {signal});
  editorFrame.addEventListener('pointerup', event => {
    if (gesture?.id !== event.pointerId || !draft) return;
    const focus = focusRect(gesture.point, normalizedPoint(event));
    gesture = null;
    if (focus[2] - focus[0] > 0.015 && focus[3] - focus[1] > 0.015) draft.focus = focus;
    showFocus(editorFrame, draft.focus);
    clear.hidden = !draft.focus;
  }, {signal});
  editorFrame.addEventListener('lostpointercapture', () => {
    gesture = null;
    showFocus(editorFrame, draft?.focus);
  }, {signal});
  clear.addEventListener('click', () => {
    draft.focus = null;
    showFocus(editorFrame, null);
    clear.hidden = true;
  }, {signal});

  if (loading) {
    videoFrameSaveQueue.catch(() => {}).then(() => fileVideoFrameNotes(session.profileId, session.file)).then(result => {
      if (signal.aborted) return;
      notes = result;
      loading = false;
      drawList();
    }).catch(error => {
      if (!signal.aborted) status.textContent = '无法读取定格批注。' + error.message;
    });
  }
  drawList();

  window.mountVideoAiAssistant?.(session, video, panel, async (timeSec, aiText) => {
    if (notes.length >= VIDEO_FRAME_NOTE_LIMIT) throw new Error('此视频定格批注已满。');
    let shot;
    try {
      shot = captureVideoFrame(video);
    } catch {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, 320, 180);
      shot = {
        id: crypto.randomUUID(),
        time: Math.max(0, Number(timeSec) || 0),
        image: c.toDataURL('image/jpeg', 0.8),
        focus: null,
        text: '',
        createdAt: new Date().toISOString()
      };
    }
    shot.time = Math.max(0, Number.isFinite(timeSec) ? timeSec : shot.time);
    shot.text = String(aiText || '').trim().slice(0, 4000);
    await persist([...notes, shot], 'AI 解析已存入定格批注');
  });
}
