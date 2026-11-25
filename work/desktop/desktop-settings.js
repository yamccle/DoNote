/**
 * [INPUT]: 读取桌面设置控件、宿主偏好消息、默认翻译语向、语音识别与成就/更新偏好。
 * [OUTPUT]: 管理四栏自适应设置中心标签切换、成就殿宇显隐开关、启动静默更新圆点提示与宿主命令分发。
 * [POS]: 桌面设置控制器，消除旧版多级悬停子菜单与碎片弹窗，可在任意阅读浮窗上方呼出。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
  const panel = document.getElementById('desktopSettings');
  const tabs = [...panel.querySelectorAll('[data-settings-group]')];
  const panes = [...panel.querySelectorAll('[data-settings-page]')];

  function activateSettingsTab(id, focusTab = false) {
    for (const tab of tabs) {
      const selected = tab.dataset.settingsGroup === id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus({ preventScroll: true });
    }
    for (const pane of panes) {
      pane.hidden = pane.dataset.settingsPage !== id;
    }
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', event => {
      event.stopPropagation();
      activateSettingsTab(tab.dataset.settingsGroup);
    });
    tab.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
        : (index + step + tabs.length) % tabs.length;
      activateSettingsTab(tabs[next].dataset.settingsGroup, true);
    });
  }
  activateSettingsTab('appearance');

  document.getElementById('desktopSettingsClose')?.addEventListener('click', () => {
    if (panel.matches(':popover-open')) panel.hidePopover();
  });

  const mode = document.getElementById('desktopThemeMode');
  mode.value = document.documentElement.dataset.themeMode || 'system';
  mode.onchange = () => window.DoNoteAppearance.applyTheme(mode.value, true);
  window.addEventListener('donote-theme-change', () => {
    mode.value = document.documentElement.dataset.themeMode || 'system';
  });

  const palette = document.getElementById('desktopPalette');
  if (palette && window.DoNoteAppearance) {
    palette.value = document.documentElement.dataset.palette || 'default';
    palette.onchange = () => window.DoNoteAppearance.applyPalette(palette.value, true);
  }

  const achToggle = document.getElementById('desktopAchievementToggle');
  const syncAchievementToggle = () => {
    if (!achToggle || !window.DoNoteAchievements) return;
    achToggle.setAttribute('aria-checked', String(window.DoNoteAchievements.isEnabled()));
  };
  if (achToggle) {
    syncAchievementToggle();
    achToggle.addEventListener('click', event => {
      event.stopPropagation();
      if (!window.DoNoteAchievements) return;
      const next = !window.DoNoteAchievements.isEnabled();
      window.DoNoteAchievements.setEnabled(next);
      syncAchievementToggle();
      if (typeof toast === 'function') toast(next ? '已开启成就殿宇与里程碑提示' : '已隐藏成就殿宇（已收集卡牌保留）');
    });
    window.addEventListener('donote-achievements-visibility', syncAchievementToggle);
    setTimeout(syncAchievementToggle, 120);
  }
}

{
  const version = document.getElementById('aboutVersion');
  let clicks = 0, lastClick = 0;
  if (version) {
    version.addEventListener('selectstart', event => event.preventDefault());
    version.addEventListener('click', event => {
      event.stopPropagation();
      const now = Date.now();
      clicks = now - lastClick > 4000 ? 1 : clicks + 1;
      lastClick = now;
      if (clicks >= 5) {
        clicks = 0;
        window.openAnalogFlashcard?.();
      }
    });
  }
}

{
  const host = location.origin === 'https://yams-one.example' && window.chrome?.webview;
  if (host) {
    const gear = document.getElementById('desktopSettingsButton');
    const panel = document.getElementById('desktopSettings');
    const splash = document.getElementById('desktopSplashToggle');
    const invert = document.getElementById('desktopPdfInvertToggle');
    const themeValue = document.getElementById('desktopThemeValue');
    const about = document.getElementById('aboutDoNote');
    const speechDialog = document.getElementById('speechModelSettings');
    const speechSelect = document.getElementById('speechModelSelect');
    const inlineSpeechSelect = document.getElementById('settingsSpeechModelSelect');
    const speechPath = document.getElementById('speechModelPath');
    const speechLabels = { base: '轻量 · base', small: '轻量 · small', 'large-v3-turbo': '均衡 · large-v3-turbo', 'large-v3': '高准确 · large-v3' };
    const speechRoot = 'models\\asr';
    const currentAsrModel = () => {
      try { return localStorage.getItem('donote-asr-model') || 'small'; } catch { return 'small'; }
    };
    const refreshSpeechFields = () => {
      const val = currentAsrModel();
      speechSelect.value = val;
      if (inlineSpeechSelect) inlineSpeechSelect.value = val;
      speechPath.textContent = speechRoot + '\\' + val + '　·　' + speechLabels[val];
      const hint = document.getElementById('settingsAsrPathHint');
      if (hint) hint.textContent = '目录：' + speechRoot + '\\' + val + '（未预置时自动走国内镜像下载）';
    };

    const inlineSrcLang = document.getElementById('settingsSourceLang');
    const inlineTgtLang = document.getElementById('settingsTargetLang');
    const syncInlineLangs = () => {
      if (typeof storedTranslateLanguage !== 'function' || !inlineSrcLang || !inlineTgtLang) return;
      const { source, target } = storedTranslateLanguage();
      inlineSrcLang.value = source;
      inlineTgtLang.value = target;
    };
    document.addEventListener('translate-language-change', syncInlineLangs);
    const applyInlineLangChange = () => {
      if (!inlineSrcLang || !inlineTgtLang) return;
      if (inlineSrcLang.value === inlineTgtLang.value) {
        inlineTgtLang.value = inlineSrcLang.value === 'zh' ? 'en' : 'zh';
      }
      const srcSel = document.getElementById('pdfSourceLang'), tgtSel = document.getElementById('pdfTargetLang');
      if (srcSel && tgtSel) {
        srcSel.value = inlineSrcLang.value;
        tgtSel.value = inlineTgtLang.value;
        document.getElementById('translateLangSave')?.click();
      }
    };
    inlineSrcLang?.addEventListener('change', applyInlineLangChange);
    inlineTgtLang?.addEventListener('change', applyInlineLangChange);

    const captionDialog = document.getElementById('videoCaptionSettings');
    const captionKey = 'donote.video.subtitle.appearance.v1';
    const captionDefaults = { size: 24, opacity: 100, font: 'sans-serif', color: '#ffffff' };
    const captionValue = () => {
      try { return { ...captionDefaults, ...JSON.parse(localStorage.getItem(captionKey) || '{}') }; }
      catch { return { ...captionDefaults }; }
    };
    const refreshCaptionSummary = () => {
      const val = captionValue();
      const el = document.getElementById('settingsCaptionSummary');
      if (el) el.textContent = '当前 ' + val.size + 'px · 不透明度 ' + val.opacity + '%';
    };
    const refreshTranslationSummary = () => {
      const el = document.getElementById('settingsTranslationSummary');
      if (el && window.desktopTranslation?.label) {
        el.textContent = '当前引擎：' + window.desktopTranslation.label();
      }
    };
    const setCaptionFields = () => {
      const value = captionValue();
      document.getElementById('captionSize').value = value.size;
      document.getElementById('captionOpacity').value = value.opacity;
      document.getElementById('captionFont').value = value.font;
      document.getElementById('captionColor').value = value.color;
      document.getElementById('captionSizeValue').textContent = value.size + 'px';
      document.getElementById('captionOpacityValue').textContent = value.opacity + '%';
      refreshCaptionSummary();
    };
    const saveCaptionFields = () => {
      const value = {
        size: Number(document.getElementById('captionSize').value),
        opacity: Number(document.getElementById('captionOpacity').value),
        font: document.getElementById('captionFont').value,
        color: document.getElementById('captionColor').value
      };
      try { localStorage.setItem(captionKey, JSON.stringify(value)); } catch {}
      setCaptionFields();
      window.dispatchEvent(new CustomEvent('donote-video-caption-change'));
    };

    const updateTheme = () => { themeValue.textContent = document.documentElement.dataset.theme === 'dark' ? '夜间' : '白天'; };
    let focusBeforeSettings;
    document.addEventListener('beforetoggle', event => {
      if (event.newState === 'closed' && event.target === panel.parentElement && panel.matches(':popover-open')) panel.hidePopover();
    }, true);

    gear.hidden = false;
    gear.addEventListener('click', event => {
      event.preventDefault();
      const parent = topWorkspaceModal() || document.body;
      if (panel.matches(':popover-open')) {
        panel.hidePopover();
        if (panel.parentElement === parent) return;
      }
      if (panel.parentElement !== parent) parent.append(panel);
      focusBeforeSettings = document.activeElement;
      panel.showPopover();
      panel.querySelector('[data-settings-group][aria-selected="true"]')?.focus({ preventScroll: true });
    });

    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      panel.hidePopover();
      if (focusBeforeSettings?.isConnected && focusBeforeSettings.getClientRects().length) {
        focusBeforeSettings.focus({ preventScroll: true });
      }
    });

    panel.addEventListener('beforetoggle', event => {
      const open = event.newState === 'open';
      gear.setAttribute('aria-expanded', String(open));
      if (open) {
        updateTheme();
        refreshSpeechFields();
        syncInlineLangs();
        refreshCaptionSummary();
        refreshTranslationSummary();
      }
    });

    panel.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || button.hasAttribute('data-settings-group') || button.id === 'desktopSettingsClose' || button.id === 'aboutVersion' || button.id === 'settingsOpenAsrFolder' || button.id === 'settingsCheckOnlineUpdate') return;
      const { control, command } = button.dataset;
      if (!control && !command) return;
      if (control === 'themeToggle') {
        document.getElementById(control).click();
        updateTheme();
      } else if (command === 'toggle-startup') {
        splash.disabled = true;
        host.postMessage(command);
      } else if (command === 'toggle-pdf-invert') {
        invert.disabled = true;
        host.postMessage(command);
      } else if (control === 'aboutDoNote') {
        panel.hidePopover();
        about.showModal();
      } else {
        panel.hidePopover();
        if (control) document.getElementById(control)?.click();
        else if (command) host.postMessage(command);
      }
    });

    inlineSpeechSelect?.addEventListener('change', () => {
      try { localStorage.setItem('donote-asr-model', inlineSpeechSelect.value); } catch {}
      refreshSpeechFields();
      toast('默认语音识别模型已切换为：' + speechLabels[inlineSpeechSelect.value]);
    });
    document.getElementById('settingsOpenAsrFolder')?.addEventListener('click', () => host.postMessage('models:open-asr'));

    document.getElementById('openSpeechModelSettings').onclick = () => {
      refreshSpeechFields();
      speechDialog.showModal();
    };
    speechSelect.onchange = () => {
      speechPath.textContent = speechRoot + '\\' + speechSelect.value + '　·　' + speechLabels[speechSelect.value];
    };
    document.getElementById('openAsrModelFolder').onclick = () => host.postMessage('models:open-asr');
    speechDialog.querySelectorAll('[data-close-speech-model]').forEach(button => button.addEventListener('click', () => speechDialog.close()));
    document.getElementById('speechModelSettingsForm').onsubmit = event => {
      event.preventDefault();
      try { localStorage.setItem('donote-asr-model', speechSelect.value); } catch {}
      refreshSpeechFields();
      speechDialog.close();
      toast('默认语音识别模型已保存：' + speechLabels[speechSelect.value]);
    };

    document.getElementById('openVideoCaptionSettings').onclick = () => { setCaptionFields(); captionDialog.showModal(); };
    captionDialog.querySelectorAll('[data-close-caption-settings]').forEach(button => button.addEventListener('click', () => captionDialog.close()));
    for (const id of ['captionSize', 'captionOpacity', 'captionFont', 'captionColor']) {
      document.getElementById(id).addEventListener('input', saveCaptionFields);
    }
    document.getElementById('captionReset').onclick = () => {
      try { localStorage.setItem(captionKey, JSON.stringify(captionDefaults)); } catch {}
      setCaptionFields();
      window.dispatchEvent(new CustomEvent('donote-video-caption-change'));
    };
    document.getElementById('videoCaptionSettingsForm').onsubmit = event => { event.preventDefault(); saveCaptionFields(); captionDialog.close(); };
    about.querySelectorAll('[data-close-about]').forEach(button => button.addEventListener('click', () => about.close()));

    // GitHub 自动在线更新检查、启动静默检测圆点提示、增量/完整包智能下载与 SHA-256 校验衔接
    const SILENT_UPDATE_KEY = 'donote-silent-update-check';
    const silentToggle = document.getElementById('desktopSilentUpdateToggle');
    const storageTabBtn = panel.querySelector('[data-settings-group="storage"]');
    const checkBtn = document.getElementById('settingsCheckOnlineUpdate');
    const updDialog = document.getElementById('onlineUpdateDialog');
    const updStatus = document.getElementById('onlineUpdateStatus');
    const updRemote = document.getElementById('onlineUpdateRemote');
    const updStrategy = document.getElementById('onlineUpdateStrategy');
    const updNotes = document.getElementById('onlineUpdateNotes');
    const updProg = document.getElementById('onlineUpdateProgress');
    const updAction = document.getElementById('onlineUpdateActionBtn');
    const updCancel = document.getElementById('onlineUpdateCancelBtn');
    const updRecheck = document.getElementById('onlineUpdateRecheck');
    let updCandidate = null, updState = 'idle', updReqId = '', silentReqId = '';

    const isSilentUpdateEnabled = () => {
      try { return localStorage.getItem(SILENT_UPDATE_KEY) !== 'off'; } catch { return true; }
    };
    const syncSilentToggle = () => {
      silentToggle?.setAttribute('aria-checked', String(isSilentUpdateEnabled()));
    };
    const setUpdateIndicator = (active, tag = '') => {
      const on = !!active;
      gear?.classList.toggle('has-update-dot', on);
      storageTabBtn?.classList.toggle('has-update-dot', on);
      if (checkBtn) checkBtn.textContent = on && tag ? '发现新版本 ' + tag : '检查在线更新';
      try { host.postMessage(on ? 'update-indicator:on' : 'update-indicator:off'); } catch {}
    };
    syncSilentToggle();
    silentToggle?.addEventListener('click', event => {
      event.stopPropagation();
      const next = !isSilentUpdateEnabled();
      try { localStorage.setItem(SILENT_UPDATE_KEY, next ? 'on' : 'off'); } catch {}
      syncSilentToggle();
      if (!next) setUpdateIndicator(false);
      else runSilentUpdateCheck();
    });

    function runSilentUpdateCheck() {
      if (!isSilentUpdateEnabled() || updState === 'downloading') return '';
      silentReqId = 'silent-' + crypto.randomUUID();
      host.postMessage({ type: 'online-update', action: 'check', id: silentReqId });
      return silentReqId;
    }
    window.DoNoteSilentUpdate = { checkNow: runSilentUpdateCheck, setIndicator: setUpdateIndicator, isEnabled: isSilentUpdateEnabled };
    setTimeout(() => { if (isSilentUpdateEnabled()) runSilentUpdateCheck(); }, 3500);

    function startOnlineCheck() {
      updState = 'checking';
      updCandidate = null;
      updReqId = crypto.randomUUID();
      updRemote.textContent = '正在查询…';
      updStrategy.textContent = '自动优选增量补丁';
      updStatus.textContent = '正在查询 GitHub Releases 最新正式版本…';
      updNotes.hidden = true;
      updProg.hidden = true;
      updAction.hidden = true;
      updCancel.hidden = true;
      updRecheck.disabled = true;
      host.postMessage({ type: 'online-update', action: 'check', id: updReqId });
    }

    checkBtn?.addEventListener('click', () => {
      if (panel.matches(':popover-open')) panel.hidePopover();
      if (!updDialog.open) updDialog.showModal();
      if (updState !== 'downloading' && updState !== 'ready-download') startOnlineCheck();
    });
    updDialog?.querySelectorAll('[data-close-online-update]').forEach(b => b.addEventListener('click', () => updDialog.close()));
    document.getElementById('onlineUpdateLocalFallback')?.addEventListener('click', () => {
      updDialog.close();
      host.postMessage('install-update');
    });
    updRecheck?.addEventListener('click', () => { if (updState !== 'downloading') startOnlineCheck(); });
    updCancel?.addEventListener('click', () => {
      host.postMessage({ type: 'online-update', action: 'cancel', id: updReqId });
    });
    updAction?.addEventListener('click', () => {
      if (updState === 'ready-download' && updCandidate) {
        updState = 'downloading';
        updReqId = crypto.randomUUID();
        updProg.hidden = false;
        updProg.value = 0;
        updAction.disabled = true;
        updAction.textContent = '正在下载…';
        updCancel.hidden = false;
        updRecheck.disabled = true;
        updStatus.textContent = '正在下载 ' + updCandidate.assetName + '…（可关闭此窗口，在右上角后台任务中心查看进度）';
        window.DoNoteTasks?.upsert('online-update', {
          title: '下载软件更新 ' + updCandidate.tag,
          detail: updCandidate.assetName,
          percent: 0,
          state: 'running',
          onOpen: () => { if (!updDialog.open) updDialog.showModal(); }
        });
        host.postMessage({
          type: 'online-update', action: 'download', id: updReqId,
          assetUrl: updCandidate.assetUrl, assetName: updCandidate.assetName,
          assetSize: updCandidate.assetSize, assetSha256: updCandidate.assetSha256 || ''
        });
      } else if (updState === 'downloaded') {
        if (!confirm('更新包已通过 SHA-256 与清单校验。\n请先确认正在编辑的记录已保存；点击确定后将自动备份旧程序、完成升级并重启 DoNote（您的 Data 资料与本地模型完全保留）。')) return;
        host.postMessage({ type: 'online-update', action: 'apply-downloaded', id: crypto.randomUUID() });
      }
    });

    host.addEventListener('message', event => {
      const msg = event.data;
      if (msg?.type === 'online-update-progress') {
        const mbDone = (msg.received / 1048576).toFixed(1), mbTotal = msg.total > 0 ? (msg.total / 1048576).toFixed(1) : '?';
        updProg.hidden = false;
        updProg.value = msg.percent || 0;
        updStatus.textContent = '正在下载 ' + msg.assetName + ' · ' + mbDone + ' / ' + mbTotal + ' MB（' + (msg.percent || 0) + '%）';
        window.DoNoteTasks?.upsert('online-update', {
          title: '下载软件更新',
          detail: mbDone + ' / ' + mbTotal + ' MB（' + (msg.percent || 0) + '%）',
          percent: msg.percent || 0,
          state: 'running',
          onOpen: () => { if (!updDialog.open) updDialog.showModal(); }
        });
        return;
      }
      if (msg?.type === 'online-update-result') {
        const isSilent = !!silentReqId && msg.id === silentReqId;
        if (isSilent) {
          silentReqId = '';
          if (msg.error || msg.cancelled) return;
          if (msg.hasUpdate) {
            updState = 'ready-download';
            updCandidate = msg;
            updRemote.textContent = msg.remoteVersion + ' (' + msg.tag + ')';
            const sizeStr = msg.assetSize < 1048576 ? (msg.assetSize / 1024).toFixed(0) + ' KB' : (msg.assetSize / 1048576).toFixed(1) + ' MB';
            updStrategy.textContent = (msg.downloadMode === 'patch' ? '增量极速补丁 · ' : '跨版本完整包 · ') + sizeStr;
            updStatus.textContent = '发现新版本 ' + msg.remoteVersion + '！系统已自动匹配最适合您当前版本的' + (msg.downloadMode === 'patch' ? '增量更新补丁' : '完整安装包') + '，下载后将自动校验 SHA-256。';
            if (msg.releaseNotes) { updNotes.textContent = msg.releaseNotes; updNotes.hidden = false; }
            updAction.hidden = false;
            updAction.disabled = false;
            updAction.textContent = '下载并验证更新（' + sizeStr + '）';
            setUpdateIndicator(true, msg.tag || msg.remoteVersion);
          } else if (msg.hasUpdate === false) {
            setUpdateIndicator(false);
          }
          return;
        }
        updRecheck.disabled = false;
        updCancel.hidden = true;
        if (msg.cancelled) {
          updState = updCandidate ? 'ready-download' : 'idle';
          updProg.hidden = true;
          updAction.disabled = false;
          updAction.hidden = !updCandidate;
          if (updCandidate) updAction.textContent = '下载并验证更新';
          updStatus.textContent = '已取消下载。';
          window.DoNoteTasks?.remove('online-update');
          return;
        }
        if (msg.error) {
          updState = updCandidate ? 'ready-download' : 'idle';
          updProg.hidden = true;
          updAction.disabled = false;
          updAction.hidden = !updCandidate;
          if (updCandidate) updAction.textContent = '重试下载';
          updStatus.textContent = msg.error;
          window.DoNoteTasks?.upsert('online-update', { title: '软件更新未完成', detail: msg.error, state: 'error' });
          return;
        }
        if (msg.downloaded) {
          updState = 'downloaded';
          setUpdateIndicator(true, msg.targetVersion);
          updProg.hidden = false;
          updProg.value = 100;
          updAction.hidden = false;
          updAction.disabled = false;
          updAction.textContent = '立即重启并安装 ' + msg.targetVersion;
          updStatus.textContent = '✓ 已下载并通过 SHA-256 与文件清单校验（' + msg.assetName + '），点击右下角按钮即可无损升级。';
          window.DoNoteTasks?.upsert('online-update', {
            title: '更新包 ' + msg.targetVersion + ' 已就绪',
            detail: '校验通过，点击打开安装',
            percent: 100,
            state: 'done',
            onOpen: () => { if (!updDialog.open) updDialog.showModal(); }
          });
          toast('DoNote ' + msg.targetVersion + ' 更新包已校验就绪', {
            label: '立即安装',
            run: () => { if (!updDialog.open) updDialog.showModal(); }
          });
          return;
        }
        if (msg.hasUpdate === false) {
          updState = 'up-to-date';
          setUpdateIndicator(false);
          updRemote.textContent = msg.remoteVersion + (msg.tag ? ' (' + msg.tag + ')' : '');
          updStrategy.textContent = '无需更新';
          updStatus.textContent = '✓ 当前已是最新正式版本（' + msg.currentVersion + '）。';
          updAction.hidden = true;
          return;
        }
        if (msg.hasUpdate) {
          updState = 'ready-download';
          updCandidate = msg;
          setUpdateIndicator(true, msg.tag || msg.remoteVersion);
          updRemote.textContent = msg.remoteVersion + ' (' + msg.tag + ')';
          const sizeStr = msg.assetSize < 1048576 ? (msg.assetSize / 1024).toFixed(0) + ' KB' : (msg.assetSize / 1048576).toFixed(1) + ' MB';
          updStrategy.textContent = (msg.downloadMode === 'patch' ? '增量极速补丁 · ' : '跨版本完整包 · ') + sizeStr;
          updStatus.textContent = '发现新版本 ' + msg.remoteVersion + '！系统已自动匹配最适合您当前版本的' + (msg.downloadMode === 'patch' ? '增量更新补丁' : '完整安装包') + '，下载后将自动校验 SHA-256。';
          if (msg.releaseNotes) {
            updNotes.textContent = msg.releaseNotes;
            updNotes.hidden = false;
          }
          updAction.hidden = false;
          updAction.disabled = false;
          updAction.textContent = '下载并验证更新（' + sizeStr + '）';
          return;
        }
      }
    });

    host.addEventListener('message', event => {
      if (event.data?.type === 'translation-settings') refreshTranslationSummary();
      if (event.data?.type !== 'yams-one-preferences') return;
      splash.setAttribute('aria-checked', String(event.data.splashEnabled));
      splash.disabled = false;
      invert.setAttribute('aria-checked', String(!!event.data.pdfInvert));
      document.documentElement.dataset.pdfInvert = event.data.pdfInvert ? 'on' : 'off';
      invert.disabled = false;
    });
    host.postMessage('startup-ready');
  }
}
