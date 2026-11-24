/**
 * [INPUT]: 读取附件、所属资料和本机阅读位置。
 * [OUTPUT]: 建立阅读会话，并保存位置和完成状态。
 * [POS]: 在 PDF 与视频阅读器之间共用。多附件资料按附件恢复状态。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';

let readingSession = null;
let readingTimer = null;
let readingSaveQueue = Promise.resolve();

function readingOwner(file) {
  return records.find(note => note.type === 'resource' && note.attachments?.some(attachment => attachment.id === file.id));
}

function checkpointKey(profileId, id) {
  return 'analog-reading/' + profileId + '/' + id;
}

function storeReadingCheckpoint(profileId, id, progress) {
  try {
    localStorage.setItem(checkpointKey(profileId, id), JSON.stringify(progress));
  } catch {}
}

function loadReadingCheckpoint(profileId, id, durable) {
  try {
    const stored = JSON.parse(localStorage.getItem(checkpointKey(profileId, id)) || 'null');
    if (stored && String(stored.lastOpened || '') >= String(durable?.lastOpened || '')) {
      return sanitizeReadingProgress(stored);
    }
  } catch {}
  return durable ? sanitizeReadingProgress(durable) : null;
}

function legacyReadingAttachment(note, progress) {
  if (!progress) return null;
  return note?.attachments?.find(progress.kind === 'video' ? fileIsVideo : fileIsPdf);
}

function storeSessionCheckpoint(session, progress) {
  storeReadingCheckpoint(session.profileId, session.file.id, progress);
}

function readingProgressSnapshot(session) {
  const { video, progress } = session;
  return sanitizeReadingProgress({
    ...progress,
    page: session.page || 1,
    scroll: session.scroll || 0,
    ...session.reflowPosition?.(),
    ...session.comparisonPosition?.(),
    time: video?.currentTime ?? progress.time,
    duration: Number.isFinite(video?.duration) ? video.duration : progress.duration,
    lastOpened: new Date().toISOString(),
  });
}

function persistReading(session) {
  if (!session || session.profileId !== appState.activeId) return Promise.resolve();
  const { file, ownerId, profileId } = session;
  if (session.progress.kind === 'pdf' && !session.pageBox) return Promise.resolve();
  if (ownerId && !records.some(note => note.id === ownerId)) return Promise.resolve();

  const progress = readingProgressSnapshot(session);
  storeSessionCheckpoint(session, progress);
  readingSaveQueue = readingSaveQueue.catch(() => {}).then(async () => {
    if (profileId !== appState.activeId) return;
    const next = structuredClone(appState);
    const profile = next.profiles.find(item => item.id === profileId);
    if (ownerId) {
      const note = profile.records.find(item => item.id === ownerId);
      if (!note?.attachments?.some(attachment => attachment.id === file.id)) return;
      // Preserve the old record-level position before replacing it with this attachment's snapshot.
      const old = loadReadingCheckpoint(profileId, ownerId, profile.reading[ownerId] || note.readerProgress);
      const previousFile = legacyReadingAttachment(note, old);
      const alreadySeparated = note.attachments.some(attachment => profile.reading[attachment.id]);
      if (previousFile && !alreadySeparated && previousFile.id !== file.id) {
        profile.reading[previousFile.id] = old;
      }
      profile.reading[ownerId] = progress;
      note.readerProgress = progress;
      note.status = progress.finished ? '已读' : '在读';
    } else if (!profile.records.some(note => note.attachments?.some(attachment => attachment.id === file.id))) {
      return;
    }
    profile.reading[file.id] = progress;
    await commitState(next);
    if (!$('reader').open) render();
  }).catch(error => toast('阅读位置未存档：' + error.message));
  return readingSaveQueue;
}

function scheduleReadingSave(session) {
  storeSessionCheckpoint(session, readingProgressSnapshot(session));
  clearTimeout(readingTimer);
  readingTimer = setTimeout(() => persistReading(session), 1000);
}

function readerStatusControls(session) {
  const bar = document.createElement('div');
  bar.className = 'reader-statusbar';
  const mark = document.createElement('button');
  mark.className = 'secondary';
  mark.id = 'markReadingDone';
  const updateLabel = () => { mark.textContent = session.progress.finished ? '标记为未读完' : '标记为已读'; };
  updateLabel();
  mark.onclick = () => {
    session.progress.finished = !session.progress.finished;
    updateLabel();
    persistReading(session);
  };
  const help = document.createElement('span');
  help.id = 'readingSaveStatus';
  help.textContent = '自动保存阅读位置 · 关闭后可继续阅读';
  bar.append(mark, help);
  return bar;
}

function createReadingSession(file, kind) {
  const owner = readingOwner(file);
  const profileId = appState.activeId;
  const reading = activeProfile().reading;
  const legacy = owner && loadReadingCheckpoint(profileId, owner.id, reading?.[owner.id] || owner.readerProgress);
  const hasAttachmentProgress = owner?.attachments.some(attachment => reading?.[attachment.id]);
  const attachmentCheckpoint = loadReadingCheckpoint(profileId, file.id, reading?.[file.id]);
  const checkpoint = attachmentCheckpoint ||
    (!hasAttachmentProgress && legacyReadingAttachment(owner, legacy)?.id === file.id ? legacy : null);
  const hasOtherReadableFile = owner?.attachments.some(attachment =>
    attachment.id !== file.id && (fileIsPdf(attachment) || fileIsVideo(attachment)));
  const finished = attachmentCheckpoint && hasOtherReadableFile
    ? attachmentCheckpoint.finished
    : legacy?.finished ?? checkpoint?.finished;
  const progress = sanitizeReadingProgress({ ...checkpoint, kind, finished });
  return {
    file,
    ownerId: owner?.id,
    profileId,
    progress,
    page: progress.page || 1,
    scroll: progress.scroll || 0,
    controller: new AbortController(),
  };
}

function closeReadingSession() {
  const session = readingSession;
  readingSession = null;
  clearTimeout(readingTimer);
  if (!session) return;
  session.video?.pause();
  void persistReading(session);
  session.controller.abort();
}

const videoExpandButton = $('readerExpandVideo');

function setVideoPreviewExpanded(expanded) {
  const dialog = $('reader');
  dialog.classList.toggle('reader-video-expanded', expanded);
  if (expanded) dialog.classList.add('reader-enhanced');
  else if (!dialog.classList.contains('reader-pdf')) dialog.classList.remove('reader-enhanced');
  const label = expanded ? '退出全屏预览' : '全屏预览';
  videoExpandButton.title = label;
  videoExpandButton.setAttribute('aria-label', label);
  videoExpandButton.setAttribute('aria-pressed', String(expanded));
}

videoExpandButton.onclick = () => {
  setVideoPreviewExpanded(!$('reader').classList.contains('reader-video-expanded'));
};

function openVideoAttachment(session, blob, content) {
  readerUrl = URL.createObjectURL(new Blob([blob], { type: session.file.mime }));
  const video = document.createElement('video');
  video.id = 'libraryVideo';
  video.className = 'reader-video';
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.src = readerUrl;
  session.video = video;

  const hint = document.createElement('p');
  hint.className = 'reader-error';
  hint.hidden = true;
  hint.textContent = '浏览器无法播放此视频编码，可下载原文件用本地播放器打开。';
  video.onloadedmetadata = () => {
    const { time } = session.progress;
    if (time && time < video.duration) video.currentTime = time;
    persistReading(session);
  };
  video.ontimeupdate = () => {
    if (readingSession === session) scheduleReadingSave(session);
  };
  video.onpause = () => {
    if (readingSession === session) persistReading(session);
  };
  video.onended = () => {
    session.progress.finished = true;
    persistReading(session);
  };
  video.onerror = () => { hint.hidden = false; };
  mountVideoFrameNotes(session, video, hint, content);
  mountVideoSubtitles(session, blob, content);
}

async function openReadableAttachment(file, blob) {
  if (fileIsPdf(file) && blob.size > MAX_PDF_PREVIEW) {
    downloadBlob(file.name, blob);
    return;
  }
  closeReadingSession();
  if (readerUrl) URL.revokeObjectURL(readerUrl);
  readerUrl = null;

  const dialog = $('reader');
  const isVideo = fileIsVideo(file);
  dialog.classList.remove('reader-enhanced');
  dialog.classList.toggle('reader-pdf', !isVideo);
  videoExpandButton.hidden = !isVideo;
  // Videos open directly as a workspace, matching the PDF reader's layout.
  // The compact button remains available for intentionally returning to a floating window.
  setVideoPreviewExpanded(isVideo);
  if (typeof registerReaderTab === 'function') registerReaderTab(file, blob);
  const session = createReadingSession(file, isVideo ? 'video' : 'pdf');
  readingSession = session;
  $('readerTitle').textContent = file.name;
  readerFile = { id: file.id, name: file.name, blob };
  const content = $('readerContent');
  const bar = readerStatusControls(session);
  content.replaceChildren(bar);
  if (!dialog.open) dialog.showModal();

  if (isVideo) {
    openVideoAttachment(session, blob, content);
    return;
  }
  await openPdfAttachment(session, blob, bar, content);
}

$('reader').addEventListener('close', event => {
  closeReadingSession();
  event.currentTarget.classList.remove('reader-pdf', 'reader-video-expanded', 'reader-enhanced');
  videoExpandButton.hidden = true;
  setVideoPreviewExpanded(false);
});
window.addEventListener('pagehide', () => {
  if (readingSession) persistReading(readingSession);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && readingSession) persistReading(readingSession);
});

$('reader').addEventListener('cancel', event => event.preventDefault());
// Let the active menu or native video fullscreen handle Escape first.
$('reader').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || document.fullscreenElement ||
      document.querySelector('.pdf-selection-menu:not([hidden])')) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.currentTarget.classList.contains('reader-video-expanded')) {
    setVideoPreviewExpanded(false);
  }
});
