/**
 * 在被采集页面里执行的脚本,用字符串而不是函数传给 Playwright:
 * 函数会被 tsx/esbuild 改写(插入 __name 之类的辅助代码),在页面里会报未定义。
 *
 * 脚本是只读的:只读取 DOM,不点击、不修改页面。
 */

export const EXTRACT_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  };
  const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return h || ''; } };
  const cssPath = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let idx = 1;
      let sib = el;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === el.tagName) idx++; }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
      el = el.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  };
  const linkOf = (a) => {
    const href = a.getAttribute('href') || '';
    const full = abs(href);
    let internal = false;
    try { internal = new URL(full).origin === location.origin; } catch (e) {}
    return { text: cut(a.textContent || a.getAttribute('aria-label') || '', 60), href: full, internal: internal };
  };
  const usableHref = (a) => {
    const h = (a.getAttribute('href') || '').trim();
    return h && !/^(javascript:|#$)/i.test(h);
  };

  // 导航与链接
  const PAGER = '.pagination, nav[aria-label*=page i], nav[aria-label*=分页], [aria-label*=pagination i], [data-pagination]';
  const nav = [];
  const navSeen = new Set();
  document.querySelectorAll('nav a[href], header a[href], [role=navigation] a[href]').forEach((a) => {
    if (nav.length >= 60 || !visible(a) || !usableHref(a) || a.closest(PAGER)) return;
    const l = linkOf(a);
    const key = l.href + '|' + l.text;
    if (navSeen.has(key) || !l.text) return;
    navSeen.add(key);
    nav.push(l);
  });
  const links = [];
  const linkSeen = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    if (links.length >= 200 || !visible(a) || !usableHref(a)) return;
    const l = linkOf(a);
    const key = l.href + '|' + l.text;
    if (linkSeen.has(key)) return;
    linkSeen.add(key);
    links.push(l);
  });

  // 标题
  const headings = [];
  document.querySelectorAll('h1, h2, h3').forEach((h) => {
    if (headings.length >= 60 || !visible(h)) return;
    const text = cut(h.textContent, 100);
    if (text) headings.push({ level: Number(h.tagName[1]), text: text });
  });

  // 表单
  const labelOf = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
      if (l) return cut(l.textContent, 60);
    }
    const wrap = el.closest('label');
    if (wrap) return cut(wrap.textContent, 60);
    return cut(el.getAttribute('aria-label') || '', 60);
  };
  const forms = [];
  document.querySelectorAll('form').forEach((f) => {
    if (forms.length >= 20 || !visible(f)) return;
    const fields = [];
    f.querySelectorAll('input, select, textarea').forEach((el) => {
      const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(type) >= 0) return;
      fields.push({
        name: el.getAttribute('name') || el.id || '',
        type: type,
        label: labelOf(el),
        required: el.required || el.getAttribute('aria-required') === 'true',
        placeholder: cut(el.getAttribute('placeholder') || '', 60),
      });
    });
    const submit = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
    forms.push({
      action: abs(f.getAttribute('action') || ''),
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: fields.slice(0, 40),
      submitText: submit ? cut(submit.value || submit.textContent || '', 40) : '',
    });
  });

  // 列表
  const lists = [];
  document.querySelectorAll('ul, ol').forEach((l) => {
    if (lists.length >= 20 || !visible(l) || l.closest('nav, header, footer')) return;
    const items = Array.from(l.children).filter((c) => c.tagName === 'LI');
    if (items.length >= 3) lists.push({ kind: 'list', itemCount: items.length, sample: items.slice(0, 3).map((i) => cut(i.textContent, 60)) });
  });
  document.querySelectorAll('table').forEach((t) => {
    if (lists.length >= 20 || !visible(t)) return;
    const rows = t.querySelectorAll('tbody tr, tr');
    if (rows.length >= 1) lists.push({ kind: 'table', itemCount: rows.length, sample: Array.from(rows).slice(0, 3).map((r) => cut(r.textContent, 80)) });
  });
  document.querySelectorAll('[class*=card], [class*=item]').forEach((c) => {
    const parent = c.parentElement;
    if (!parent || parent.__uievSeen || lists.length >= 20) return;
    const same = Array.from(parent.children).filter((x) => x.className === c.className);
    if (same.length >= 3 && visible(parent) && parent.tagName !== 'UL' && parent.tagName !== 'OL') {
      parent.__uievSeen = true;
      lists.push({ kind: 'cards', itemCount: same.length, sample: same.slice(0, 3).map((i) => cut(i.textContent, 60)) });
    }
  });

  // 弹窗
  const dialogs = [];
  document.querySelectorAll('dialog, [role=dialog], [role=alertdialog], .modal').forEach((d) => {
    if (dialogs.length >= 10) return;
    const h = d.querySelector('h1, h2, h3, h4');
    const text = cut(d.getAttribute('aria-label') || (h ? h.textContent : '') || d.textContent, 80);
    if (text) dialogs.push(text);
  });

  // 可点击元素分类:能安全执行的、只记录不执行的
  const DANGER = /删除|移除|提交|支付|付款|购买|下单|退出|注销|确认|发送|保存|登录|注册|取消订单|delete|remove|submit|pay|buy|purchase|checkout|logout|sign ?out|confirm|send|save|login|sign ?in|register/i;
  const interactions = [];
  const blocked = [];
  const seen = new Set();
  document.querySelectorAll('a[href], button, [role=button], [role=tab], input[type=button], input[type=submit], [data-modal], [data-tab], [aria-haspopup]').forEach((el) => {
    if (!visible(el)) return;
    const text = cut(el.value || el.textContent || el.getAttribute('aria-label') || '', 40);
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const inForm = !!el.closest('form');
    const isSubmit = (tag === 'BUTTON' && inForm && (type === 'submit' || type === '')) || type === 'submit';

    const isTab = el.getAttribute('role') === 'tab' || el.hasAttribute('data-tab');
    const isModal = el.matches('[aria-haspopup=dialog], [data-modal], [data-bs-toggle=modal], [data-toggle=modal]');
    const isPager = !!el.closest(PAGER) || el.matches('a[rel=next], a[rel=prev]');

    if (isSubmit) { blocked.push({ text: text || '(提交按钮)', reason: '表单提交会改变目标系统数据,不执行' }); return; }
    if (DANGER.test(text) && !(tag === 'A' && !isTab && !isModal && !isPager)) {
      blocked.push({ text: text, reason: '按钮文字表明可能改变数据,不执行' });
      return;
    }
    const kind = isTab ? 'tab' : isModal ? 'modal' : isPager ? 'pagination' : null;
    if (kind) {
      const selector = cssPath(el);
      if (seen.has(selector) || interactions.length >= 30) return;
      seen.add(selector);
      interactions.push({ type: kind, selector: selector, text: text });
      return;
    }
    if (tag !== 'A' && blocked.length < 40) {
      blocked.push({ text: text || '(无文字)', reason: '未识别的可点击元素,默认不执行' });
    }
  });

  return {
    title: document.title || '',
    lang: document.documentElement.getAttribute('lang') || '',
    headings: headings,
    nav: nav,
    links: links,
    forms: forms,
    lists: lists,
    dialogs: dialogs,
    interactions: interactions,
    blocked: blocked.slice(0, 40),
  };
})()`;

/** 逐屏滚动一次,触发懒加载,然后回到顶部 */
export const SCROLL_SCRIPT = String.raw`(async () => {
  const step = Math.max(200, window.innerHeight - 100);
  let y = 0;
  for (let i = 0; i < 25; i++) {
    const total = document.documentElement.scrollHeight;
    if (y >= total) break;
    y += step;
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
})()`;
