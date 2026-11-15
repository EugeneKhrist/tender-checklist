import { h, api, toast, safeUrl, fmtDeadline, isExpired, prepareImage, fill } from './lib.js';

const state = {
  config: { recognition: false, recognition_note: '', model: '' },
  tenders: [],
  filters: { q: '', company: '' },
  notices: new Map(), // id закупки -> сообщения последнего распознавания
};
const root = document.getElementById('app');

const STATUS = [
  ['todo', 'Не начато'],
  ['in_progress', 'В работе'],
  ['done', 'Готово'],
];
const REQUIRED_LABEL = { yes: 'Обязательно', no: 'Не обязательно', unclear: 'Требует проверки' };

/* =============================== запуск и маршрутизация =============================== */

async function boot() {
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const main = h('main');
  root.replaceChildren(shell(hash), main);
  window.scrollTo(0, 0);
  const run = (fn) =>
    fn().catch((err) => {
      main.replaceChildren(h('div', { class: 'banner banner-error' }, err.message), h('a', { class: 'btn', href: '#/' }, 'К списку закупок'));
    });

  let m;
  if (hash === '/') run(() => renderList(main));
  else if (hash === '/new') run(() => renderNew(main));
  else if ((m = hash.match(/^\/t\/(\d+)$/))) run(() => renderTender(main, Number(m[1])));
  else location.hash = '#/';
}

function shell() {
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'topbar-inner' }, h('a', { class: 'brand', href: '#/' }, 'Чек-лист тендеров и ЗЦП')),
  );
}

/* =============================== список закупок =============================== */

function progressBlock(p) {
  const pct = p.required_total ? Math.round((p.required_done / p.required_total) * 100) : 0;
  const complete = p.required_total > 0 && p.required_done === p.required_total;
  const bar = h('div', { class: `bar ${complete ? 'complete' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('span'));
  bar.firstChild.style.width = `${pct}%`;
  return h(
    'div',
    { class: 'progress' },
    h(
      'div',
      { class: 'progress-text' },
      h('span', {}, p.required_total ? `Обязательные пункты: ${p.required_done} из ${p.required_total}` : 'Обязательных пунктов пока нет'),
      complete ? h('span', { class: 'badge badge-ok' }, 'Всё готово') : null,
      p.unclear > 0 ? h('span', { class: 'badge badge-warn' }, 'Остались требования на проверке') : null,
    ),
    bar,
  );
}

function openButton(t, cls = '') {
  const href = t.url ? safeUrl(t.url) : null;
  return href
    ? h('a', { class: `btn ${cls}`, href, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть закупку')
    : h('span', { class: `btn ${cls}`, 'aria-disabled': 'true', title: 'Ссылка на закупку не указана' }, 'Ссылка не указана');
}

function tenderCard(t) {
  const deadline = fmtDeadline(t);
  return h(
    'article',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: `company ${t.company ? '' : 'muted'}` }, t.company || 'Заказчик не указан'),
      t.type ? h('span', { class: 'badge badge-type' }, t.type) : null,
      t.is_draft ? h('span', { class: 'badge' }, 'Черновик') : null,
    ),
    h('h2', { class: 'tender-title' }, t.title || 'Без названия'),
    h(
      'div',
      { class: 'meta' },
      h(
        'div',
        {},
        h('span', { class: 'k' }, 'Срок подачи: '),
        deadline ? h('strong', {}, deadline) : h('span', { class: 'muted' }, 'не указан'),
        t.review_flags.deadline ? [' ', h('span', { class: 'badge badge-warn' }, 'Требует проверки')] : null,
        !t.review_flags.deadline && isExpired(t) ? [' ', h('span', { class: 'badge' }, 'Срок прошёл')] : null,
      ),
      t.number ? h('div', {}, h('span', { class: 'k' }, 'Номер: '), t.number) : null,
    ),
    progressBlock(t.progress),
    h('div', { class: 'actions' }, openButton(t), h('a', { class: 'btn btn-primary', href: `#/t/${t.id}` }, 'Карточка и чек-лист')),
  );
}

function sortTenders(list) {
  const rank = (t) => (t.deadline_date ? (isExpired(t) ? 2 : 0) : 1);
  return [...list].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return `${a.deadline_date}${a.deadline_time || ''}`.localeCompare(`${b.deadline_date}${b.deadline_time || ''}`);
    return b.id - a.id;
  });
}

async function renderList(main) {
  main.replaceChildren(h('p', { class: 'muted', text: 'Загрузка…' }));
  state.tenders = await api('GET', '/api/tenders');
  const f = state.filters;

  const companies = [...new Set(state.tenders.map((t) => t.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (f.company && !companies.includes(f.company)) f.company = '';

  const list = h('div', { class: 'stack' });
  const paint = () => {
    const q = f.q.trim().toLowerCase();
    const shown = sortTenders(
      state.tenders.filter(
        (t) =>
          (!f.company || t.company === f.company) &&
          (!q || [t.company, t.title, t.number].some((v) => String(v || '').toLowerCase().includes(q))),
      ),
    );
    if (!shown.length) {
      list.replaceChildren(
        h(
          'div',
          { class: 'empty card' },
          state.tenders.length ? 'По этим условиям закупок нет.' : 'Закупок пока нет. Нажмите «Добавить закупку».',
        ),
      );
    } else list.replaceChildren(...shown.map(tenderCard));
  };

  const search = h('input', { type: 'search', placeholder: 'Поиск по названию, номеру…', value: f.q, 'aria-label': 'Поиск', oninput: (e) => { f.q = e.target.value; paint(); } });
  const company = h(
    'select',
    { 'aria-label': 'Фильтр по компании', value: f.company, onchange: (e) => { f.company = e.target.value; paint(); } },
    h('option', { value: '' }, 'Все компании'),
    companies.map((c) => h('option', { value: c }, c)),
  );

  main.replaceChildren(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Закупки'), h('a', { class: 'btn btn-primary', href: '#/new' }, 'Добавить закупку')),
    h('div', { class: 'filters two' }, search, company),
    list,
  );
  paint();
}

/* =============================== новая закупка =============================== */

async function renderNew(main) {
  state.config = await api('GET', '/api/config').catch(() => state.config);
  const files = [];
  const url = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', placeholder: 'https://…', id: 'new-url' });
  const thumbs = h('div', { class: 'thumbs' });
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'new-files' });
  const error = h('div', { class: 'banner banner-error', hidden: true });
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, 'Распознать');
  const manual = h('button', { class: 'btn btn-link', type: 'button' }, 'Заполнить вручную, без распознавания');
  const drop = h('div', { class: 'dropzone' });

  const repaint = () => {
    thumbs.replaceChildren(
      ...files.map((f, i) => {
        const src = URL.createObjectURL(f);
        return h(
          'div',
          { class: 'thumb' },
          h('img', { src, alt: `Скриншот ${i + 1}`, onload: () => URL.revokeObjectURL(src) }),
          h('span', {}, `Скриншот ${i + 1}`),
          h('button', { class: 'rm', type: 'button', 'aria-label': `Убрать скриншот ${i + 1}`, onclick: () => { files.splice(i, 1); repaint(); } }, '×'),
        );
      }),
    );
    thumbs.hidden = !files.length;
  };
  const addFiles = async (list) => {
    for (const file of list) {
      if (files.length >= 10) {
        toast('За один раз можно добавить не больше 10 скриншотов', 'error');
        break;
      }
      try {
        files.push(await prepareImage(file));
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    repaint();
  };
  picker.addEventListener('change', async () => {
    await addFiles([...picker.files]);
    picker.value = '';
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  const onPaste = (e) => {
    if (!document.body.contains(drop)) return document.removeEventListener('paste', onPaste);
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) addFiles(imgs);
  };
  document.addEventListener('paste', onPaste);

  drop.append(
    h('p', { class: 'muted' }, 'Скриншоты карточки закупки и страниц с требованиями. Можно несколько; на компьютере — перетащить или вставить из буфера (Ctrl+V).'),
    h('label', { class: 'btn', for: 'new-files' }, 'Выбрать скриншоты'),
    picker,
    thumbs,
  );

  const submit = async (mode) => {
    error.hidden = true;
    if (mode !== 'manual' && !url.value.trim() && !files.length) {
      error.textContent = 'Добавьте ссылку на закупку или хотя бы один скриншот.';
      error.hidden = false;
      return;
    }
    const fd = new FormData();
    fd.append('url', url.value.trim());
    if (mode) fd.append('mode', mode);
    files.forEach((f) => fd.append('files', f, f.name));
    go.disabled = manual.disabled = true;
    go.replaceChildren(h('span', { class: 'spinner' }), ' Распознаём… это может занять несколько минут');
    try {
      const res = await api('POST', '/api/tenders/recognize', fd);
      state.notices.set(res.tender.id, res.notices);
      location.hash = `#/t/${res.tender.id}`;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      go.disabled = manual.disabled = false;
      go.replaceChildren('Распознать');
    }
  };
  go.addEventListener('click', () => submit(''));
  manual.addEventListener('click', () => submit('manual'));
  repaint();

  fill(
    main,
    h('a', { href: '#/' }, '← К списку'),
    h('h1', {}, 'Новая закупка'),
    state.config.recognition
      ? null
      : h(
          'div',
          { class: 'banner banner-warn' },
          h('strong', {}, 'Распознавание сейчас недоступно'),
          h('span', {}, state.config.recognition_note || 'Нет связи с локальной моделью.'),
          h('span', {}, 'Карточку можно заполнить вручную («Заполнить вручную» внизу).'),
        ),
    h(
      'div',
      { class: 'card stack' },
      h('div', {}, h('label', { for: 'new-url' }, 'Ссылка на закупку'), url, h('p', { class: 'hint' }, 'Приложение прочитает страницу, если она открыта без входа в аккаунт.')),
      h('div', {}, h('label', {}, 'Скриншоты документации'), drop),
      error,
      go,
      manual,
    ),
  );
}

/* =============================== карточка закупки =============================== */

async function renderTender(main, id) {
  main.replaceChildren(h('p', { class: 'muted', text: 'Загрузка…' }));
  let t = await api('GET', `/api/tenders/${id}`);
  const notices = state.notices.get(id) || [];
  state.notices.delete(id);

  const paint = (extraNotices = []) => {
    const parts = [];
    parts.push(
      h('a', { href: '#/' }, '← К списку'),
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, t.company || t.title || 'Закупка'), t.is_draft ? h('span', { class: 'badge' }, 'Черновик') : null),
    );
    const banners = [];
    for (const n of extraNotices) banners.push(h('div', { class: `banner banner-${n.level === 'error' ? 'error' : n.level === 'info' ? 'info' : 'warn'}` }, n.text));
    if (['login_required', 'unreachable', 'empty'].includes(t.url_status)) {
      banners.push(
        h(
          'div',
          { class: 'banner banner-warn' },
          h('strong', {}, 'Ссылка сохранена, но прочитать страницу не удалось'),
          h('span', {}, `${t.url_note} Загрузите скриншоты страницы закупки и требований ниже — распознавание продолжится по ним.`),
        ),
      );
    }
    if (t.needs_requirements) {
      banners.push(
        h(
          'div',
          { class: 'banner banner-warn' },
          h('strong', {}, 'Нужны страницы с требованиями'),
          h('span', {}, 'В материалах видна только карточка закупки. Добавьте скриншоты страниц с требованиями к заявке (документы, условия) — и нажмите «Распознать снова».'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { t = await api('PATCH', `/api/tenders/${t.id}`, { needs_requirements: false }); paint(); } }, 'Скрыть напоминание'),
        ),
      );
    }
    if (t.is_draft) banners.push(h('div', { class: 'banner banner-info' }, 'Это черновик. Проверьте данные, исправьте при необходимости и нажмите «Сохранить карточку».'));
    parts.push(...banners, cardForm(), screenshotsSection(), checklistSection());
    main.replaceChildren(...parts);
  };

  /* ----- форма карточки ----- */
  function cardForm() {
    const flags = { ...t.review_flags };
    const inputs = {};
    const wrappers = {};

    const flagBox = (key) => {
      const box = h('div', { class: 'flag', hidden: !flags[key] });
      const draw = () => {
        box.replaceChildren(
          h('span', { class: 'badge' }, 'Требует проверки'),
          h('span', {}, flags[key] || ''),
          h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              onclick: async () => {
                delete flags[key];
                box.hidden = true;
                try {
                  await api('PATCH', `/api/tenders/${t.id}`, { review_flags: flags });
                  t.review_flags = { ...flags };
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Всё верно',
          ),
        );
      };
      draw();
      return box;
    };
    const clearFlag = (key) => () => {
      if (flags[key]) {
        delete flags[key];
        wrappers[key].querySelector('.flag').hidden = true;
      }
    };
    const field = (key, label, control, hint) => {
      wrappers[key] = h('div', {}, h('label', { for: `f-${key}` }, label), control, hint ? h('p', { class: 'hint' }, hint) : null, flagBox(key));
      control.id = `f-${key}`;
      control.addEventListener('input', clearFlag(key));
      return wrappers[key];
    };

    inputs.company = h('input', { type: 'text', value: t.company });
    inputs.title = h('textarea', { rows: 2, value: t.title });
    inputs.type = h('select', { value: t.type || '' }, h('option', { value: '' }, '— не выбран —'), h('option', { value: 'Тендер' }, 'Тендер'), h('option', { value: 'ЗЦП' }, 'ЗЦП'));
    inputs.number = h('input', { type: 'text', value: t.number });
    inputs.deadline_date = h('input', { type: 'date', value: t.deadline_date || '', 'aria-label': 'Дата окончания подачи' });
    inputs.deadline_time = h('input', { type: 'time', value: t.deadline_time || '', 'aria-label': 'Время окончания подачи' });
    inputs.deadline_tz = h('input', { type: 'text', value: t.deadline_tz, placeholder: 'МСК, UTC+3…', 'aria-label': 'Часовой пояс' });
    inputs.url = h('input', { type: 'text', inputmode: 'url', value: t.url, placeholder: 'https://…', autocomplete: 'off' });

    const deadlineWrap = h(
      'div',
      {},
      h('label', { for: 'f-deadline' }, 'Срок окончания подачи'),
      h('div', { class: 'deadline-row' }, inputs.deadline_date, inputs.deadline_time, h('div', { class: 'tz' }, inputs.deadline_tz)),
      t.deadline_raw ? h('p', { class: 'hint' }, `В источнике: «${t.deadline_raw}»`) : null,
      flagBox('deadline'),
    );
    inputs.deadline_date.id = 'f-deadline';
    wrappers.deadline = deadlineWrap;
    for (const k of ['deadline_date', 'deadline_time', 'deadline_tz']) inputs[k].addEventListener('input', clearFlag('deadline'));

    const urlHref = () => safeUrl(inputs.url.value.trim().includes('://') ? inputs.url.value.trim() : `https://${inputs.url.value.trim()}`);
    const openRow = h('div', { class: 'row' });
    const paintOpen = () => {
      fill(
        openRow,
        inputs.url.value.trim() && urlHref()
          ? h('a', { class: 'btn btn-small', href: urlHref(), target: '_blank', rel: 'noopener noreferrer' }, 'Открыть закупку')
          : null,
      );
    };
    inputs.url.addEventListener('input', paintOpen);
    paintOpen();

    const collect = () => ({
      company: inputs.company.value,
      title: inputs.title.value,
      type: inputs.type.value || null,
      number: inputs.number.value,
      deadline_date: inputs.deadline_date.value || null,
      deadline_time: inputs.deadline_time.value || null,
      deadline_tz: inputs.deadline_tz.value,
      url: inputs.url.value,
      review_flags: flags,
    });
    cardForm.collect = collect;

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, t.is_draft ? 'Сохранить карточку' : 'Сохранить изменения');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const wasDraft = t.is_draft;
        t = await api('PATCH', `/api/tenders/${t.id}`, { ...collect(), save: true });
        toast(wasDraft ? 'Карточка сохранена' : 'Изменения сохранены');
        paint();
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false;
      }
    });
    const delBtn = h('button', { class: 'btn btn-danger', type: 'button' }, 'Удалить закупку');
    delBtn.addEventListener('click', async () => {
      if (!confirm('Удалить закупку вместе с чек-листом и скриншотами? Это нельзя отменить.')) return;
      try {
        await api('DELETE', `/api/tenders/${t.id}`);
        toast('Закупка удалена');
        location.hash = '#/';
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    return h(
      'section',
      { class: 'card stack' },
      h('h2', {}, 'Карточка закупки'),
      h(
        'div',
        { class: 'fields two' },
        h('div', { class: 'span2' }, field('company', 'Компания-заказчик', inputs.company, 'Название из реквизитов заказчика')),
        h('div', { class: 'span2' }, field('title', 'Название закупки или конкурса', inputs.title)),
        field('type', 'Тип', inputs.type),
        field('number', 'Номер закупки или лота', inputs.number),
        h('div', { class: 'span2' }, deadlineWrap),
        h(
          'div',
          { class: 'span2' },
          field('url', 'Прямая ссылка на закупку', inputs.url, t.url ? null : 'Ссылку можно добавить позже — например, когда будет доступ к странице.'),
          openRow,
        ),
        h('div', { class: 'span2 small muted' }, `Добавлено: ${new Date(t.created_at).toLocaleDateString('ru-RU')}`),
      ),
      h('div', { class: 'actions' }, saveBtn, delBtn),
    );
  }

  /* ----- скриншоты и повторное распознавание ----- */
  function screenshotsSection() {
    const newFiles = [];
    const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'more-files' });
    const preview = h('div', { class: 'small muted' });
    const rerun = h('button', { class: 'btn btn-primary', type: 'button' }, 'Распознать снова');
    picker.addEventListener('change', async () => {
      for (const file of [...picker.files]) {
        try {
          newFiles.push(await prepareImage(file));
        } catch (err) {
          toast(err.message, 'error');
        }
      }
      picker.value = '';
      preview.textContent = newFiles.length ? `Выбрано новых скриншотов: ${newFiles.length}` : '';
    });
    rerun.addEventListener('click', async () => {
      rerun.disabled = true;
      rerun.replaceChildren(h('span', { class: 'spinner' }), ' Распознаём…');
      try {
        // Сначала сохраняем правки из формы, чтобы распознавание их не затёрло.
        await api('PATCH', `/api/tenders/${t.id}`, cardForm.collect());
        const fd = new FormData();
        newFiles.forEach((f) => fd.append('files', f, f.name));
        const res = await api('POST', `/api/tenders/${t.id}/recognize`, fd);
        t = res.tender;
        paint(res.notices);
        toast(res.added ? `Добавлено пунктов чек-листа: ${res.added}` : 'Распознавание завершено');
      } catch (err) {
        toast(err.message, 'error');
        rerun.disabled = false;
        rerun.replaceChildren('Распознать снова');
      }
    });
    return h(
      'section',
      { class: 'card stack', id: 'screens' },
      h('h2', {}, 'Материалы'),
      t.files.length
        ? h(
            'div',
            { class: 'thumbs' },
            t.files.map((f) =>
              h('a', { class: 'thumb', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/files/${f.id}`, alt: `Скриншот ${f.ordinal}`, loading: 'lazy' }), h('span', {}, `Скриншот ${f.ordinal}`)),
            ),
          )
        : h('p', { class: 'muted' }, 'Скриншотов пока нет.'),
      h('p', { class: 'hint' }, 'Можно добавить ещё скриншоты — например, страницы с требованиями. Уже подтверждённые вами поля не изменятся, в чек-лист добавятся только новые пункты.'),
      h('div', { class: 'row' }, h('label', { class: 'btn', for: 'more-files' }, 'Добавить скриншоты'), picker, rerun),
      preview,
    );
  }

  /* ----- чек-лист ----- */
  function checklistSection() {
    const head = h('div', { class: 'stack' });
    const list = h('div', { class: 'items' });
    const paintHead = () => {
      const p = {
        required_total: t.items.filter((i) => i.required === 'yes').length,
        required_done: t.items.filter((i) => i.required === 'yes' && i.status === 'done').length,
        unclear: t.items.filter((i) => i.required === 'unclear').length,
      };
      t.progress = { ...p, total_items: t.items.length };
      head.replaceChildren(progressBlock(p));
    };
    const paintItems = () => {
      list.replaceChildren(...(t.items.length ? t.items.map(itemEl) : [h('p', { class: 'muted' }, 'Пунктов пока нет. Добавьте вручную или загрузите материалы с требованиями.')]));
    };
    const replaceItem = (item) => {
      const idx = t.items.findIndex((x) => x.id === item.id);
      t.items[idx] = item;
      const old = list.querySelector(`[data-item="${item.id}"]`);
      const wasOpen = old?.querySelector('details')?.open;
      const fresh = itemEl(item);
      if (wasOpen) fresh.querySelector('details').open = true;
      old?.replaceWith(fresh);
      paintHead();
    };
    const patchItem = async (item, body, rerender = true) => {
      try {
        const saved = await api('PATCH', `/api/items/${item.id}`, body);
        if (rerender) replaceItem(saved);
        else {
          Object.assign(item, saved);
          paintHead();
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    function itemEl(item) {
      const sourceLine =
        item.source_type === 'screenshot'
          ? h('div', { class: 'source' }, 'Источник: ', item.source_file_id ? h('a', { href: `/api/files/${item.source_file_id}`, target: '_blank', rel: 'noopener' }, `скриншот ${item.source_ordinal ?? ''}`.trim()) : 'скриншот')
          : item.source_type === 'link'
            ? h('div', { class: 'source' }, 'Источник: страница по ссылке')
            : h('div', { class: 'source' }, 'Источник: добавлено вручную');

      const seg = h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': `Статус: ${item.title}` },
        STATUS.map(([value, label]) =>
          h('button', { type: 'button', 'data-s': value, 'aria-pressed': item.status === value ? 'true' : 'false', onclick: () => item.status !== value && patchItem(item, { status: value }) }, label),
        ),
      );

      const title = h('input', { type: 'text', value: item.title, 'aria-label': 'Название пункта' });
      title.addEventListener('change', () => title.value.trim() && patchItem(item, { title: title.value }));
      const required = h('select', { value: item.required, 'aria-label': 'Обязательность' }, ['yes', 'no', 'unclear'].map((v) => h('option', { value: v }, REQUIRED_LABEL[v])));
      required.addEventListener('change', () => patchItem(item, { required: required.value }));
      const assignee = h('input', { type: 'text', value: item.assignee, placeholder: 'Кто делает', 'aria-label': 'Ответственный' });
      assignee.addEventListener('change', () => patchItem(item, { assignee: assignee.value }, false));
      const comment = h('textarea', { rows: 2, value: item.comment, placeholder: 'Комментарий', 'aria-label': 'Комментарий' });
      comment.addEventListener('change', () => patchItem(item, { comment: comment.value }, false));
      const remove = h('button', { class: 'btn btn-danger btn-small', type: 'button' }, 'Удалить пункт');
      remove.addEventListener('click', async () => {
        if (!confirm(`Удалить пункт «${item.title}»?`)) return;
        try {
          await api('DELETE', `/api/items/${item.id}`);
          t.items = t.items.filter((x) => x.id !== item.id);
          paintItems();
          paintHead();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      return h(
        'div',
        { class: `item ${item.status === 'done' ? 'done' : ''} ${item.required === 'unclear' ? 'unclear' : ''}`, 'data-item': item.id },
        h(
          'div',
          { class: 'item-top' },
          h('div', { class: 'item-title' }, item.title),
          h(
            'div',
            { class: 'badges' },
            h('span', { class: `badge ${item.required === 'yes' ? 'badge-req' : item.required === 'unclear' ? 'badge-warn' : ''}` }, REQUIRED_LABEL[item.required]),
          ),
          item.required === 'unclear'
            ? h(
                'div',
                { class: 'row' },
                h('span', { class: 'small' }, 'Обязательно ли это требование?'),
                h('button', { class: 'btn btn-small', type: 'button', onclick: () => patchItem(item, { required: 'yes' }) }, 'Обязательно'),
                h('button', { class: 'btn btn-small', type: 'button', onclick: () => patchItem(item, { required: 'no' }) }, 'Не обязательно'),
              )
            : null,
          sourceLine,
          item.excerpt ? h('blockquote', { class: 'excerpt' }, item.excerpt) : null,
        ),
        seg,
        item.assignee || item.comment
          ? h('div', { class: 'assign-line' }, item.assignee ? h('div', {}, h('strong', {}, 'Ответственный: '), item.assignee) : null, item.comment ? h('div', { class: 'muted' }, item.comment) : null)
          : null,
        h(
          'details',
          {},
          h('summary', {}, 'Изменить, ответственный, комментарий'),
          h('div', { class: 'edit' }, h('div', {}, h('label', {}, 'Название пункта'), title), h('div', {}, h('label', {}, 'Обязательность'), required), h('div', {}, h('label', {}, 'Ответственный'), assignee), h('div', {}, h('label', {}, 'Комментарий'), comment), remove),
        ),
      );
    }

    const newTitle = h('input', { type: 'text', placeholder: 'Например: подтвердить срок поставки', 'aria-label': 'Новый пункт' });
    const newReq = h('select', { 'aria-label': 'Обязательность нового пункта' }, ['yes', 'no', 'unclear'].map((v) => h('option', { value: v }, REQUIRED_LABEL[v])));
    const addBtn = h('button', { class: 'btn', type: 'button' }, 'Добавить пункт');
    const addItem = async () => {
      if (!newTitle.value.trim()) return newTitle.focus();
      addBtn.disabled = true;
      try {
        const item = await api('POST', `/api/tenders/${t.id}/items`, { title: newTitle.value, required: newReq.value });
        t.items.push(item);
        newTitle.value = '';
        paintItems();
        paintHead();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        addBtn.disabled = false;
      }
    };
    addBtn.addEventListener('click', addItem);
    newTitle.addEventListener('keydown', (e) => e.key === 'Enter' && addItem());

    paintHead();
    paintItems();
    return h(
      'section',
      { class: 'card stack' },
      h('h2', {}, 'Чек-лист'),
      head,
      list,
      h('div', { class: 'add-item' }, newTitle, newReq, addBtn),
    );
  }

  paint(notices);
}

boot();
