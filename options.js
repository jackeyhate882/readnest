/* 阅巢 ReadNest — 设置页 */
(function () {
  const { util, settings, store, K, articles } = RN;
  const $ = (s) => document.querySelector(s);

  function apiVisible() {
    const p = document.querySelector('input[name="provider"]:checked');
    $('#apiBox').hidden = !(p && p.value === 'api');
  }

  async function fill() {
    const s = await settings.all();
    document.querySelectorAll('input[name="provider"]').forEach((r) => {
      r.checked = r.value === s.provider;
      r.addEventListener('change', apiVisible);
    });
    $('#targetLang').value = s.targetLang;
    $('#apiBase').value = s.apiBase || '';
    $('#apiModel').value = s.apiModel || '';
    $('#apiKey').value = s.apiKey || '';
    $('#theme').value = s.theme || 'paper';
    $('#fontSize').value = s.fontSize || 19;
    $('#fontVal').textContent = s.fontSize || 19;
    $('#lineWidth').value = s.lineWidth || 700;
    $('#widthVal').textContent = s.lineWidth || 700;
    $('#fallbackViaTab').checked = s.fallbackViaTab !== false;
    $('#closeSourceTab').checked = s.closeSourceTab !== false;
    $('#autoSummary').checked = !!s.autoSummary;
    $('#summaryLength').value = s.summaryLength || 'medium';
    apiVisible();
    dataStat();
  }

  const save = util.debounce(async (patch, notify) => {
    await settings.set(patch);
    if (notify) util.toast('已保存');
  }, 220);

  function bind() {
    document.querySelectorAll('input[name="provider"]').forEach((r) => {
      r.addEventListener('change', () => {
        const p = document.querySelector('input[name="provider"]:checked');
        save({ provider: p ? p.value : 'google' }, true);
      });
    });
    $('#targetLang').addEventListener('change', () => save({ targetLang: $('#targetLang').value }, true));
    for (const id of ['apiBase', 'apiModel', 'apiKey']) {
      $('#' + id).addEventListener('input', () => save({ [id]: $('#' + id).value.trim() }));
    }
    $('#theme').addEventListener('change', () => save({ theme: $('#theme').value }, true));
    $('#fontSize').addEventListener('input', () => {
      $('#fontVal').textContent = $('#fontSize').value;
      save({ fontSize: Number($('#fontSize').value) });
    });
    $('#lineWidth').addEventListener('input', () => {
      $('#widthVal').textContent = $('#lineWidth').value;
      save({ lineWidth: Number($('#lineWidth').value) });
    });
    $('#fallbackViaTab').addEventListener('change', () => save({ fallbackViaTab: $('#fallbackViaTab').checked }));
    $('#closeSourceTab').addEventListener('change', () => save({ closeSourceTab: $('#closeSourceTab').checked }));
    $('#autoSummary').addEventListener('change', () => save({ autoSummary: $('#autoSummary').checked }, true));
    $('#summaryLength').addEventListener('change', () => save({ summaryLength: $('#summaryLength').value }, true));

    $('#btnTest').addEventListener('click', async () => {
      const btn = $('#btnTest');
      const out = $('#testOut');
      btn.disabled = true;
      out.className = 'test-out';
      out.textContent = '正在翻译…';
      try {
        await settings.set({
          provider: (document.querySelector('input[name="provider"]:checked') || {}).value || 'google',
          targetLang: $('#targetLang').value,
          apiBase: $('#apiBase').value.trim(),
          apiModel: $('#apiModel').value.trim(),
          apiKey: $('#apiKey').value.trim(),
        });
        const res = await RN.translate.test('Agents need memory that persists across sessions, and a way to forget.');
        out.className = 'test-out ok';
        out.textContent = '成功（' + res.ms + 'ms）：' + res.out;
      } catch (e) {
        out.className = 'test-out err';
        out.textContent = '失败：' + (e.message || e) + (e.hint ? ' — ' + e.hint : '');
      } finally {
        btn.disabled = false;
      }
    });

    $('#btnExportAll').addEventListener('click', exportAll);
    $('#btnClear').addEventListener('click', clearAll);
  }

  async function dataStat() {
    const list = await articles.index();
    const words = list.reduce((s, a) => s + (a.wordCount || 0), 0);
    const hl = list.reduce((s, a) => s + (a.hlCount || 0), 0);
    const nt = list.reduce((s, a) => s + (a.noteCount || 0), 0);
    $('#dataStat').textContent =
      '书库里现在有 ' + list.length + ' 篇文章，共 ' + words.toLocaleString('en-US') + ' 字，' + hl + ' 处高亮，' + nt + ' 条笔记。';
  }

  async function exportAll() {
    const list = await articles.index();
    if (!list.length) return util.toast('书库是空的');
    const full = [];
    for (const m of list) {
      const a = await articles.get(m.id);
      if (a) full.push(a);
    }
    const payload = { app: 'ReadNest', version: 1, exportedAt: new Date().toISOString(), articles: full };
    util.download('readnest-backup-' + util.fmtDay(Date.now()) + '.json', JSON.stringify(payload, null, 2), 'application/json');
    util.toast('已导出 ' + full.length + ' 篇');
  }

  async function clearAll() {
    const list = await articles.index();
    if (!list.length) return util.toast('书库是空的');
    if (!confirm('确定清空书库里的 ' + list.length + ' 篇文章？高亮和笔记会一起删除，且无法恢复。')) return;
    for (const a of list) await store.remove(K.article(a.id));
    await articles.saveIndex([]);
    util.toast('已清空');
    dataStat();
  }

  fill();
  bind();
})();
