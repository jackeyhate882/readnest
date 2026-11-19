/* 阅巢 ReadNest — 书库 */
(function () {
  const { articles, util } = RN;
  const $ = (s) => document.querySelector(s);
  const state = { all: [], q: '', tag: '', sort: 'saved' };

  function readerUrl(id) {
    return util.pageUrl('reader.html?id=' + encodeURIComponent(id));
  }

  async function load() {
    try {
      state.all = await articles.index();
    } catch (e) {
      state.all = [];
    }
    render();
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    let list = state.all.slice();
    if (q) {
      list = list.filter((a) => {
        const hay = [a.title, a.siteName, (a.tags || []).join(' '), a.excerpt].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    if (state.tag) list = list.filter((a) => (a.tags || []).indexOf(state.tag) >= 0);
    const by = {
      saved: (a, b) => (b.savedAt || 0) - (a.savedAt || 0),
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      words: (a, b) => (b.wordCount || 0) - (a.wordCount || 0),
      title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'),
    };
    list.sort(by[state.sort] || by.saved);
    list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
    return list;
  }

  function renderTags() {
    const row = $('#tagRow');
    row.textContent = '';
    const tags = new Set();
    for (const a of state.all) for (const t of a.tags || []) tags.add(t);
    if (!tags.size) return;
    const mk = (label, value) => {
      const b = document.createElement('button');
      b.className = 'chip' + (state.tag === value ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        state.tag = state.tag === value ? '' : value;
        render();
      });
      row.appendChild(b);
    };
    mk('全部', '');
    Array.from(tags).sort().forEach((t) => mk(t, t));
  }

  function render() {
    const list = visible();
    const grid = $('#grid');
    grid.textContent = '';
    const empty = $('#empty');
    empty.hidden = list.length > 0 || state.all.length > 0;
    if (state.all.length && !list.length) {
      const none = document.createElement('div');
      none.className = 'empty';
      none.style.margin = '30px auto';
      none.innerHTML = '<h2>没有匹配的文章</h2><p>换个关键词，或清空筛选条件试试。</p>';
      grid.appendChild(none);
    }
    for (const a of list) grid.appendChild(card(a));

    const hl = state.all.reduce((s, a) => s + (a.hlCount || 0), 0);
    const nt = state.all.reduce((s, a) => s + (a.noteCount || 0), 0);
    $('#libStat').textContent =
      state.all.length + ' 篇文章' + (hl ? ' · ' + hl + ' 处高亮' : '') + (nt ? ' · ' + nt + ' 条笔记' : '');
    renderTags();
  }

  function card(a) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = a.id;
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      location.href = readerUrl(a.id);
    });

    const top = document.createElement('div');
    top.className = 'card-top';
    const site = document.createElement('span');
    site.className = 'site';
    site.textContent = a.siteName || util.hostOf(a.url);
    const star = document.createElement('button');
    star.className = 'star' + (a.starred ? ' on' : '');
    star.textContent = a.starred ? '★' : '☆';
    star.title = a.starred ? '取消置顶' : '置顶';
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      a.starred = !a.starred;
      await articles.updateMeta(a.id, { starred: a.starred });
      const art = await articles.get(a.id);
      if (art) {
        art.starred = a.starred;
        await RN.store.set(RN.K.article(a.id), art);
      }
      render();
    });
    top.append(site, star);

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = a.title || '（无标题）';

    const exc = document.createElement('p');
    exc.className = 'card-exc';
    exc.textContent = a.excerpt || (a.byline ? a.byline : '（没有摘要）');

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const bits = [];
    if (a.wordCount) bits.push(a.wordCount.toLocaleString('en-US') + ' 字');
    if (a.readingTime) bits.push('约 ' + a.readingTime + ' 分钟');
    bits.push(util.fmtDay(a.savedAt));
    for (const b of bits) {
      const s = document.createElement('span');
      s.textContent = b;
      meta.appendChild(s);
    }
    if (a.hlCount) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = a.hlCount + ' 处高亮';
      meta.appendChild(p);
    }
    if (a.noteCount) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = a.noteCount + ' 条笔记';
      meta.appendChild(p);
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const read = document.createElement('a');
    read.textContent = '阅读 →';
    read.href = readerUrl(a.id);
    const src = document.createElement('a');
    src.textContent = '原文 ↗';
    src.href = a.canonicalUrl || a.url;
    src.target = '_blank';
    src.rel = 'noopener';
    const del = document.createElement('a');
    del.className = 'del';
    del.textContent = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除《' + a.title + '》？高亮和笔记会一起删除。')) return;
      await articles.remove(a.id);
      util.toast('已删除');
      load();
    });
    foot.append(read, src, del);

    el.append(top, title, exc, meta);
    if ((a.tags || []).length) {
      const tags = document.createElement('div');
      tags.className = 'card-tags';
      for (const t of a.tags) {
        const s = document.createElement('span');
        s.textContent = t;
        tags.appendChild(s);
      }
      el.appendChild(tags);
    }
    el.appendChild(foot);
    return el;
  }

  function showOp(text, err, hint) {
    const bar = $('#opbar');
    bar.hidden = false;
    bar.className = 'opbar' + (err ? ' err' : '');
    $('#opText').innerHTML = util.esc(text) + (hint ? '<span class="hint"> ' + util.esc(hint) + '</span>' : '');
  }
  function hideOp() {
    $('#opbar').hidden = true;
  }

  async function addUrl() {
    let url = ($('#addUrl').value || '').trim();
    if (!url) {
      $('#addUrl').focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    $('#btnAdd').disabled = true;
    showOp('正在抓取网页正文，通常几秒内完成…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'capture:url', url, open: false });
      if (res && res.ok) {
        $('#addUrl').value = '';
        showOp('抓取成功：' + (res.title || url) + '，可以开始阅读了');
        await load();
        setTimeout(hideOp, 2600);
        if (res.id) setTimeout(() => location.href = readerUrl(res.id), 300);
      } else {
        showOp('抓取失败：' + ((res && res.error) || '未知错误'), true, res && res.hint);
      }
    } catch (e) {
      showOp('抓取失败：' + e.message, true);
    } finally {
      $('#btnAdd').disabled = false;
    }
  }

  function bind() {
    $('#btnAdd').addEventListener('click', addUrl);
    $('#addUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addUrl();
    });
    $('#search').addEventListener(
      'input',
      util.debounce(() => {
        state.q = $('#search').value;
        render();
      }, 120)
    );
    $('#sort').addEventListener('change', () => {
      state.sort = $('#sort').value;
      render();
    });
    $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    // 支持阅读页拖拽/返回后刷新
    window.addEventListener('focus', () => load());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement === document.body) {
        e.preventDefault();
        $('#search').focus();
      }
    });
  }

  bind();
  load();
  if (new URLSearchParams(location.search).get('welcome')) {
    util.toast('安装完成！把文章链接粘到上面，或点浏览器右上角图标抓取当前页面');
  }
})();
