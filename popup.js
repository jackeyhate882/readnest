/* 阅巢 ReadNest — 弹窗 */
(function () {
  const { articles, util } = RN;
  const $ = (sel) => document.querySelector(sel);
  const OWN_PREFIX = 'chrome-extension://' + chrome.runtime.id;

  let busy = false;

  function setBusy(on, text) {
    busy = on;
    $('#btnGrab').disabled = on;
    $('#btnUrl').disabled = on;
    if (text) showStatus(text, 'info');
  }

  function showStatus(msg, type, hint) {
    const el = $('#status');
    el.hidden = false;
    el.className = 'status' + (type === 'error' ? ' error' : '');
    el.innerHTML = util.esc(msg) + (hint ? '<span class="hint">' + util.esc(hint) + '</span>' : '');
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function grabCurrent() {
    if (busy) return;
    const tab = await activeTab();
    if (!tab || !tab.url || /^(edge|chrome|about|devtools|view-source):/i.test(tab.url) || tab.url.indexOf(OWN_PREFIX) === 0) {
      showStatus('这个页面不能抓取', 'error', '请切换到一篇普通网页（http/https），或直接在下方粘贴链接。');
      return;
    }
    setBusy(true, '正在解析当前页面…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'capture:tab', tabId: tab.id });
      if (res && res.ok) {
        showStatus('已保存，正在打开阅读页…');
        setTimeout(() => window.close(), 500);
      } else {
        setBusy(false);
        showStatus((res && res.error) || '抓取失败', 'error', res && res.hint);
      }
    } catch (err) {
      setBusy(false);
      showStatus('抓取失败：' + err.message, 'error');
    }
  }

  async function grabUrl() {
    if (busy) return;
    let url = ($('#url').value || '').trim();
    if (!url) {
      $('#url').focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    setBusy(true, '正在抓取网页正文，通常几秒内完成…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'capture:url', url });
      if (res && res.ok) {
        showStatus('抓取成功，阅读页已打开');
        setTimeout(() => window.close(), 600);
      } else {
        setBusy(false);
        showStatus((res && res.error) || '抓取失败', 'error', res && res.hint);
      }
    } catch (err) {
      setBusy(false);
      showStatus('抓取失败：' + err.message, 'error');
    }
  }

  async function renderRecent() {
    const list = (await articles.index()).slice(0, 6);
    const ul = $('#recentList');
    ul.textContent = '';
    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = '书库还是空的。打开一篇想读的文章，点上面的按钮抓进来。';
      ul.replaceWith(div);
      $('#count').textContent = '';
      return;
    }
    for (const a of list) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = a.title;
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = (a.siteName || '') + ' · ' + util.fmtDay(a.savedAt) + (a.hlCount ? ' · ' + a.hlCount + ' 处高亮' : '');
      li.append(t, m);
      li.title = a.title;
      li.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?id=' + encodeURIComponent(a.id)) });
        window.close();
      });
      ul.appendChild(li);
    }
    const total = await articles.index();
    $('#count').textContent = '共 ' + total.length + ' 篇';
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderRecent();
    $('#btnGrab').addEventListener('click', grabCurrent);
    $('#btnUrl').addEventListener('click', grabUrl);
    $('#url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') grabUrl();
    });
    $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('#btnLibrary').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
      window.close();
    });
  });
})();
