/**
 * [INPUT]: 读取桌面设置控件、宿主偏好消息、默认翻译语向与语音识别配置。
 * [OUTPUT]: 管理三栏聚合设置中心标签切换、内联快捷设置同步、成就闪卡彩蛋与宿主命令分发。
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
}

{
  const about = document.getElementById('aboutDoNote'), version = document.getElementById('aboutVersion');
  const dialog = document.getElementById('analogFlashcard'), flip = document.getElementById('flashcardFlip');
  const save = document.getElementById('flashcardSave');
  const panel = document.getElementById('desktopSettings');
  const cards = [{ kind: 'analog-v1', number: '001', title: '信号路径', image: 'analog-flashcard.png' }];
  const capacity = 10;
  let clicks = 0, lastClick = 0, unlocking = false;
  const collectible = () => records.find(note => note.flashcardKind === 'analog-v1');
  const unlockedCards = () => cards.filter(card => records.some(note => note.flashcardKind === card.kind)).sort((a, b) => Number(a.number) - Number(b.number));
  const refresh = () => { save.textContent = collectible() ? '查看成就殿宇' : unlocking ? '正在解锁…' : '重试解锁'; save.disabled = unlocking; };
  const showHall = () => { if (dialog.open) dialog.close(); switchView('pinned'); tab = 'achievements'; render(); };
  const unlock = async () => {
    if (collectible() || unlocking) { refresh(); return; }
    if (!ready) { toast('资料库尚未就绪，稍后可重试解锁。'); refresh(); return; }
    unlocking = true; refresh();
    try {
      await put({
        id: crypto.randomUUID(), type: 'custom-achievement', title: '设计闪卡 001 · 信号路径', date: today(),
        body: '先理解信号路径，再优化每个指标。\n从输入到输出，标出增益、带宽、噪声与反馈。每次改动，都回到这条路径验证。',
        tags: [], status: '已解锁', pinned: false, attachments: [], flashcardKind: 'analog-v1'
      });
      render(); toast('已解锁成就闪卡 001。', { label: '查看殿宇', run: showHall });
    } catch (error) { toast('解锁失败：' + error.message); }
    finally { unlocking = false; refresh(); }
  };
  const open = () => {
    if (about.open) about.close();
    if (panel?.matches(':popover-open')) panel.hidePopover();
    flip.setAttribute('aria-pressed', 'false');
    dialog.showModal();
    refresh();
    void unlock();
  };
  version.addEventListener('selectstart', event => event.preventDefault());
  flip.addEventListener('dragstart', event => event.preventDefault());
  version.addEventListener('click', event => {
    event.stopPropagation();
    const now = Date.now();
    clicks = now - lastClick > 4000 ? 1 : clicks + 1;
    lastClick = now;
    if (clicks >= 5) { clicks = 0; open(); }
  });
  dialog.querySelectorAll('[data-close-flashcard]').forEach(button => button.addEventListener('click', () => dialog.close()));
  flip.addEventListener('click', () => flip.setAttribute('aria-pressed', String(flip.getAttribute('aria-pressed') !== 'true')));
  save.addEventListener('click', () => { if (collectible()) showHall(); else void unlock(); });
  window.openAnalogFlashcard = open;
  window.renderAchievementHall = () => {
    const unlocked = unlockedCards();
    const host = document.getElementById('records');
    host.classList.toggle('achievement-display', view === 'pinned' && tab === 'achievements');
    document.querySelector('.searchrow').hidden = view === 'pinned' && tab === 'achievements';
    if (view !== 'pinned' || tab !== 'achievements') return;
    document.getElementById('libraryPager').hidden = true;
    host.innerHTML = '<section class="achievement-hall" aria-label="成就殿宇"><div class="achievement-hall-heading"><div><span>DONOTE · ACHIEVEMENTS</span><h3>成就殿宇</h3><p>每张卡记录一次值得珍藏的发现。</p></div><strong>已解锁 ' + unlocked.length + ' / ' + capacity + '</strong></div><div class="achievement-grid">' + unlocked.map(card => '<button type="button" class="achievement-tile" data-achievement="' + card.kind + '" aria-label="打开成就闪卡 ' + card.number + ' ' + card.title + '"><img src="' + card.image + '" draggable="false" alt=""><span>NO. ' + card.number + '</span><strong>' + card.title + '</strong></button>').join('') + '</div></section>';
    host.querySelectorAll('[data-achievement]').forEach(button => button.addEventListener('click', open));
  };
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
      if (!button || button.disabled || button.hasAttribute('data-settings-group') || button.id === 'desktopSettingsClose' || button.id === 'aboutVersion' || button.id === 'settingsOpenAsrFolder') return;
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
