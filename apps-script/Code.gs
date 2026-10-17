/**
 * Million Hair Studio — LINE booking backend (Google Apps Script, bound to the Google Sheet)
 *
 * Script Properties (Project Settings → Script properties):
 *   LINE_TOKEN        Channel access token (long-lived) ของ Messaging API channel
 *   LOGIN_CHANNEL_ID  Channel ID ของ LINE Login channel (MillionHair Queue App)
 *   ADMIN_USER_IDS    LINE User ID ของแอดมิน คั่นด้วย ,
 *   PROMPTPAY_ID      (ไม่บังคับ) เบอร์/เลขบัตรสำหรับ QR มัดจำ — ว่างไว้ = โหมดสาธิต ไม่ต้องโอนจริง
 *
 * ติดตั้ง: รัน setup() 1 ครั้ง แล้ว setupRichMenu() 1 ครั้ง (หลัง GitHub Pages อัปเดตแล้ว)
 */

const TZ = 'Asia/Bangkok';
const SHEET = 'Bookings';
const SITE = 'https://nongnapatlab.github.io/million-hair-queue/';
const LIFF_URL = 'https://liff.line.me/2012052973-UNW6H5DF';

// ---------- ข้อมูลร้าน (ร้านสมมติสำหรับโครงงาน) ----------
const SHOP = {
  name: 'Million Hair Studio',
  hours: 'เปิด 10:00–20:00 น. · ปิดทุกวันพุธ',
  address: '[ที่อยู่ร้านสมมติ]',
  phone: '[เบอร์ร้านสมมติ]',
  open: 10 * 60, close: 20 * 60, closedDays: [3], // 0=อา … 3=พ
  slotStep: 30, leadMin: 30, daysAhead: 14,
  deposit: 300,
};
const LENGTHS = [
  { code: 'S', th: 'สั้น', mult: 0.8 },
  { code: 'M', th: 'ประบ่า', mult: 1 },
  { code: 'L', th: 'ยาว', mult: 1.3 },
  { code: 'XL', th: 'ยาวมาก', mult: 1.6 },
];
// chem: ราคาคิดตามความยาวผม (ไม่แบ่งเพศ)
const SERVICES = [
  { id: 'cut', th: 'ตัดผม', en: 'HAIRCUT', min: 45, price: 500, chem: false },
  { id: 'wash', th: 'สระ-ไดร์', en: 'WASH & BLOW-DRY', min: 30, price: 400, chem: false },
  { id: 'color', th: 'ทำสี', en: 'COLOR', min: 120, price: 2500, chem: true },
  { id: 'bleach', th: 'ไฮไลท์ / บลีช', en: 'HIGHLIGHT & BLEACH', min: 180, price: 3500, chem: true },
  { id: 'perm', th: 'ดัด', en: 'PERM', min: 150, price: 2800, chem: true },
  { id: 'straight', th: 'ยืด', en: 'STRAIGHTENING', min: 180, price: 3200, chem: true },
  { id: 'treat', th: 'ทรีตเมนต์', en: 'TREATMENT', min: 45, price: 1000, chem: true },
];
const STYLISTS = [
  { id: 'max', name: 'Max', role: 'Senior · Cut & fade' },
  { id: 'ploy', name: 'Ploy', role: 'Color & bleach' },
  { id: 'ken', name: 'Ken', role: 'Perm & texture' },
  { id: 'nina', name: 'Nina', role: 'Treatment & styling' },
  { id: 'tee', name: 'Tee', role: 'Cut & color' },
];
const CHEMICALS = ['ทำสี', 'บลีช', 'ดัด', 'ยืด', 'เคราติน'];
const PRONOUNS = ['ไม่ระบุ', 'He', 'She', 'They'];

const STATUS = {
  CONFIRMED: 'ยืนยันแล้ว', ARRIVED: 'มาถึงแล้ว', SERVING: 'รับบริการ',
  DONE: 'เสร็จสิ้น', NO_SHOW: 'ไม่มา', CANCELLED: 'ยกเลิก',
};
const ACTIVE = [STATUS.CONFIRMED, STATUS.ARRIVED, STATUS.SERVING];
const DEPOSIT = { DEMO: 'สาธิต (ไม่ต้องโอน)', SLIP: 'แนบสลิปแล้ว · รอตรวจ', PAID: 'ตรวจแล้ว', NONE: 'ไม่เก็บมัดจำ' };

const HEADERS = ['Created At', 'Booking ID', 'Date', 'Start', 'End', 'Duration', 'Stylist', 'Services',
  'Hair Length', 'Est. Price', 'Deposit', 'Deposit Status', 'Status', 'Name', 'Phone', 'Pronoun',
  'Chemical History', 'Note', 'Ref Photos', 'Slip', 'LINE User ID', 'Visit No', 'Arrived At',
  'Started At', 'Finished At', 'Cancelled At', 'Reminder Sent', 'Channel'];
const K = {}; // ชื่อ field → index (0-based)
['created', 'id', 'date', 'start', 'end', 'duration', 'stylist', 'services', 'length', 'price', 'deposit',
  'depositStatus', 'status', 'name', 'phone', 'pronoun', 'chem', 'note', 'photos', 'slip', 'uid', 'visit',
  'arrived', 'started', 'finished', 'cancelled', 'reminded', 'channel'].forEach((k, i) => { K[k] = i; });

// ---------- setup ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET, 0);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#1E2B3C').setFontColor('#F6F6F4');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, sh.getMaxRows() - 1, HEADERS.length).setNumberFormat('@'); // เก็บทุกอย่างเป็นข้อความ
  sh.hideColumns(K.uid + 1);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('UPLOAD_FOLDER_ID')) {
    props.setProperty('UPLOAD_FOLDER_ID', DriveApp.createFolder('Million Hair Uploads (ส่วนตัว)').getId());
  }

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(18).inTimezone(TZ).create();
}

/** สร้าง rich menu ตามดีไซน์ (5 ปุ่ม) แล้วตั้งเป็นค่าเริ่มต้นของทุกคน */
function setupRichMenu() {
  const W = 2500, H = 1686, top = 843, third = Math.round(W / 3);
  const area = (x, y, w, h, uri) => ({ bounds: { x, y, width: w, height: h }, action: { type: 'uri', uri } });
  const menu = {
    size: { width: W, height: H }, selected: true, name: 'Million Hair main', chatBarText: 'เมนู',
    areas: [
      area(0, 0, third * 2, top, LIFF_URL + '?page=book'),
      area(third * 2, 0, W - third * 2, top, LIFF_URL + '?page=my'),
      area(0, top, third, H - top, LIFF_URL + '?page=price'),
      area(third, top, third, H - top, LIFF_URL + '?page=stylists'),
      area(third * 2, top, W - third * 2, H - top, LIFF_URL + '?page=lookbook'),
    ],
  };
  const created = lineApi_('https://api.line.me/v2/bot/richmenu', 'post', JSON.stringify(menu), 'application/json');
  const id = JSON.parse(created).richMenuId;
  const img = UrlFetchApp.fetch(SITE + 'assets/richmenu.jpg').getBlob();
  lineApi_(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, 'post', img.getBytes(), 'image/jpeg');
  lineApi_(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, 'post', '', 'application/json');
  console.log('rich menu ready:', id);
}

// ---------- Web App ----------

function doGet(e) {
  if ((e.parameter.action || '') === 'config') return json_(publicConfig_());
  return json_({ ok: true, app: SHOP.name });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const uid = verifyIdToken_(body.idToken);
    switch (body.action) {
      case 'slots': return json_(slots_(body));
      case 'book': return json_(book_(uid, body));
      case 'my': return json_(myBookings_(uid));
      case 'cancel': return json_(cancel_(uid, body.id));
      case 'reschedule': return json_(reschedule_(uid, body));
      case 'last': return json_(lastProfile_(uid));
      default:
        if (String(body.action).startsWith('admin_')) return json_(admin_(uid, body));
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function publicConfig_() {
  const props = PropertiesService.getScriptProperties();
  const pp = props.getProperty('PROMPTPAY_ID');
  return {
    ok: true, shop: SHOP, lengths: LENGTHS, services: SERVICES, stylists: STYLISTS,
    chemicals: CHEMICALS, pronouns: PRONOUNS, dates: bookableDates_(),
    promptpay: pp ? promptPayPayload_(pp, SHOP.deposit) : null,
  };
}

// ---------- pricing / time helpers ----------

const priceOf_ = (svc, len) => {
  const m = (LENGTHS.find(l => l.code === len) || LENGTHS[1]).mult;
  return svc.chem ? Math.round(svc.price * m / 100) * 100 : svc.price;
};
const toMin_ = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const toHHMM_ = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const nowStr_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
const todayStr_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

function bookableDates_() {
  const out = [];
  for (let i = 0; i < SHOP.daysAhead; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const ymd = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    const dow = Number(Utilities.formatDate(d, TZ, 'u')) % 7; // u: 1=จ … 7=อา
    out.push({ date: ymd, dow, closed: SHOP.closedDays.includes(dow) });
  }
  return out;
}

function quote_(serviceIds, len) {
  const svcs = (serviceIds || []).map(id => SERVICES.find(s => s.id === id)).filter(Boolean);
  if (!svcs.length) throw new Error('กรุณาเลือกบริการอย่างน้อย 1 อย่าง');
  return {
    svcs,
    minutes: svcs.reduce((s, x) => s + x.min, 0),
    price: svcs.reduce((s, x) => s + priceOf_(x, len), 0),
  };
}

/** สล็อตว่างของวันนั้น: stylist = id หรือ 'any' */
function slots_(body) {
  const date = String(body.date);
  const day = bookableDates_().find(d => d.date === date);
  if (!day || day.closed) return { ok: true, date, closed: true, slots: [] };
  const minutes = Number(body.minutes) || 30;
  const busy = busyMap_(date, body.excludeId);
  const ids = body.stylist && body.stylist !== 'any' ? [body.stylist] : STYLISTS.map(s => s.id);
  const nowMin = date === todayStr_() ? toMin_(Utilities.formatDate(new Date(), TZ, 'HH:mm')) + SHOP.leadMin : 0;

  const slots = [];
  for (let t = SHOP.open; t + minutes <= SHOP.close; t += SHOP.slotStep) {
    const free = t >= nowMin && ids.some(id => isFree_(busy[id], t, t + minutes));
    slots.push({ time: toHHMM_(t), free });
  }
  return { ok: true, date, closed: false, minutes, slots };
}

function busyMap_(date, excludeId) {
  const map = {};
  STYLISTS.forEach(s => { map[s.id] = []; });
  rows_().forEach(r => {
    if (r.v[K.date] !== date || r.v[K.status] === STATUS.CANCELLED || r.v[K.id] === excludeId) return;
    const sid = (STYLISTS.find(s => s.name === r.v[K.stylist]) || {}).id;
    if (sid) map[sid].push([toMin_(r.v[K.start]), toMin_(r.v[K.end])]);
  });
  return map;
}
const isFree_ = (ranges, a, b) => !(ranges || []).some(([s, e]) => a < e && s < b);

/** หาช่างที่ว่าง: ถ้าเลือก any ให้คนที่มีนัดน้อยที่สุดในวันนั้น */
function pickStylist_(date, wanted, start, minutes, excludeId) {
  const busy = busyMap_(date, excludeId);
  const ids = wanted && wanted !== 'any' ? [wanted] : STYLISTS.map(s => s.id);
  const free = ids.filter(id => isFree_(busy[id], start, start + minutes))
    .sort((a, b) => busy[a].length - busy[b].length);
  if (!free.length) throw new Error('ช่วงเวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาใหม่');
  return STYLISTS.find(s => s.id === free[0]);
}

function validateSlot_(date, time, minutes) {
  const day = bookableDates_().find(d => d.date === date);
  if (!day || day.closed) throw new Error('วันนี้ร้านปิดหรืออยู่นอกช่วงที่จองได้');
  const start = toMin_(time);
  if (!(start >= SHOP.open && start + minutes <= SHOP.close)) throw new Error('เวลาไม่อยู่ในช่วงเปิดร้าน');
  if (date === todayStr_() && start < toMin_(Utilities.formatDate(new Date(), TZ, 'HH:mm')) + SHOP.leadMin) {
    throw new Error('เวลานี้ผ่านไปแล้ว');
  }
  return start;
}

// ---------- customer actions ----------

function book_(uid, b) {
  const name = String(b.name || '').trim().slice(0, 50);
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (!name) throw new Error('กรุณากรอกชื่อเล่น');
  if (!/^0\d{8,9}$/.test(phone)) throw new Error('กรุณากรอกเบอร์โทรให้ถูกต้อง');
  if (b.consent !== true) throw new Error('ต้องยินยอมให้เก็บข้อมูลก่อนจอง');
  const len = LENGTHS.some(l => l.code === b.length) ? b.length : 'M';
  const q = quote_(b.services, len);
  const start = validateSlot_(b.date, b.time, q.minutes);

  const pp = PropertiesService.getScriptProperties().getProperty('PROMPTPAY_ID');
  const slipUrl = b.slip ? saveUpload_(b.slip, `slip_${b.date}_${name}`) : '';
  if (pp && !slipUrl) throw new Error('กรุณาแนบสลิปมัดจำ');
  const photoUrls = (b.photos || []).slice(0, 3).map((p, i) => saveUpload_(p, `ref_${b.date}_${name}_${i + 1}`));

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let rec;
  try {
    const stylist = pickStylist_(b.date, b.stylist, start, q.minutes);
    const id = `MH-${b.date.slice(5, 7)}${b.date.slice(8, 10)}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const visit = rows_().filter(r => r.v[K.uid] === uid && r.v[K.status] !== STATUS.CANCELLED).length + 1;
    const v = new Array(HEADERS.length).fill('');
    Object.assign(v, {
      [K.created]: nowStr_(), [K.id]: id, [K.date]: b.date, [K.start]: toHHMM_(start), [K.end]: toHHMM_(start + q.minutes),
      [K.duration]: String(q.minutes), [K.stylist]: stylist.name, [K.services]: q.svcs.map(s => s.th).join(', '),
      [K.length]: len, [K.price]: String(q.price), [K.deposit]: String(SHOP.deposit),
      [K.depositStatus]: pp ? DEPOSIT.SLIP : DEPOSIT.DEMO, [K.status]: STATUS.CONFIRMED,
      [K.name]: name, [K.phone]: phone, [K.pronoun]: PRONOUNS.includes(b.pronoun) ? b.pronoun : 'ไม่ระบุ',
      [K.chem]: (b.chemicals || []).filter(c => CHEMICALS.includes(c)).join(', '),
      [K.note]: String(b.note || '').slice(0, 300), [K.photos]: photoUrls.join(' '), [K.slip]: slipUrl,
      [K.uid]: uid, [K.visit]: String(visit), [K.channel]: 'LINE',
    });
    appendRow_(v);
    rec = toBooking_(v);
  } finally {
    lock.releaseLock();
  }
  push_(uid, [confirmFlex_(rec, 'BOOKING CONFIRMED'),
    { type: 'text', text: 'เราจะแจ้งเตือนอีกครั้งก่อนถึงนัด 1 วันนะครับ ✦' }]);
  return { ok: true, booking: rec };
}

function myBookings_(uid) {
  const today = todayStr_();
  const mine = rows_().filter(r => r.v[K.uid] === uid).map(r => toBooking_(r.v));
  const upcoming = mine.filter(b => b.date >= today && ACTIVE.includes(b.status))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const past = mine.filter(b => !upcoming.includes(b)).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  return { ok: true, upcoming, past: past.slice(0, 10) };
}

function lastProfile_(uid) {
  const mine = rows_().filter(r => r.v[K.uid] === uid);
  const last = mine[mine.length - 1];
  return { ok: true, profile: last ? { name: last.v[K.name], phone: last.v[K.phone], pronoun: last.v[K.pronoun], length: last.v[K.length] } : null };
}

function cancel_(uid, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const r = findOwn_(uid, id);
    if (r.v[K.status] !== STATUS.CONFIRMED) throw new Error('นัดนี้ยกเลิกไม่ได้แล้ว');
    setCells_(r.row, { [K.status]: STATUS.CANCELLED, [K.cancelled]: nowStr_() });
    const b = toBooking_(r.v);
    const late = hoursUntil_(b) < 24;
    push_(uid, [{ type: 'text', text: `ยกเลิกนัด ${b.id} (${thaiDate_(b.date)} ${b.start} น.) เรียบร้อยแล้ว` +
      (late ? '\nเนื่องจากยกเลิกภายใน 24 ชม. ก่อนนัด มัดจำจะไม่ได้รับคืนตามเงื่อนไขร้าน' : '') }]);
    return { ok: true, late };
  } finally {
    lock.releaseLock();
  }
}

function reschedule_(uid, b) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const r = findOwn_(uid, b.id);
    if (r.v[K.status] !== STATUS.CONFIRMED) throw new Error('นัดนี้เลื่อนไม่ได้แล้ว');
    const minutes = Number(r.v[K.duration]);
    const start = validateSlot_(b.date, b.time, minutes);
    const wanted = (STYLISTS.find(s => s.name === r.v[K.stylist]) || {}).id;
    const stylist = pickStylist_(b.date, b.keepStylist === false ? 'any' : wanted, start, minutes, r.v[K.id]);
    setCells_(r.row, { [K.date]: b.date, [K.start]: toHHMM_(start), [K.end]: toHHMM_(start + minutes), [K.stylist]: stylist.name, [K.reminded]: '' });
    const rec = toBooking_(rows_().find(x => x.row === r.row).v);
    push_(uid, [confirmFlex_(rec, 'BOOKING RESCHEDULED')]);
    return { ok: true, booking: rec };
  } finally {
    lock.releaseLock();
  }
}

function findOwn_(uid, id) {
  const r = rows_().find(x => x.v[K.id] === id && x.v[K.uid] === uid);
  if (!r) throw new Error('ไม่พบนัดนี้');
  return r;
}

// ---------- reminders (time trigger ทุกวัน 18:00) ----------

function sendReminders() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd');
  rows_().forEach(r => {
    const v = r.v;
    if (v[K.date] !== tomorrow || v[K.status] !== STATUS.CONFIRMED || v[K.reminded] || !v[K.uid]) return;
    push_(v[K.uid], [confirmFlex_(toBooking_(v), 'REMINDER · พรุ่งนี้มีนัด')]);
    setCells_(r.row, { [K.reminded]: nowStr_() });
  });
}

// ---------- admin ----------

function admin_(uid, b) {
  const admins = (PropertiesService.getScriptProperties().getProperty('ADMIN_USER_IDS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.includes(uid)) return { ok: false, error: 'NOT_ADMIN', userId: uid };
  const re = /^\d{4}-\d{2}-\d{2}$/;

  if (b.action === 'admin_day') {
    if (!re.test(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
    return { ok: true, bookings: rows_().filter(r => r.v[K.date] === b.date).map(r => toBooking_(r.v, true)), config: publicConfig_() };
  }
  if (b.action === 'admin_set_status') {
    if (!Object.values(STATUS).includes(b.status)) throw new Error('สถานะไม่ถูกต้อง');
    const r = rows_().find(x => x.v[K.id] === b.id);
    if (!r) throw new Error('ไม่พบนัด');
    const stamp = { [STATUS.ARRIVED]: K.arrived, [STATUS.SERVING]: K.started, [STATUS.DONE]: K.finished, [STATUS.CANCELLED]: K.cancelled }[b.status];
    const cells = { [K.status]: b.status };
    if (stamp !== undefined && !r.v[stamp]) cells[stamp] = nowStr_();
    if (b.status === STATUS.SERVING && !r.v[K.arrived]) cells[K.arrived] = nowStr_();
    setCells_(r.row, cells);
    return { ok: true };
  }
  if (b.action === 'admin_deposit') {
    const r = rows_().find(x => x.v[K.id] === b.id);
    if (!r) throw new Error('ไม่พบนัด');
    setCells_(r.row, { [K.depositStatus]: DEPOSIT.PAID });
    return { ok: true };
  }
  if (b.action === 'admin_book') { // Walk-in / โทรจอง
    const name = String(b.name || '').trim().slice(0, 50);
    if (!name) throw new Error('กรุณากรอกชื่อ');
    const len = LENGTHS.some(l => l.code === b.length) ? b.length : 'M';
    const q = quote_(b.services, len);
    const start = toMin_(b.time);
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const stylist = pickStylist_(b.date, b.stylist, start, q.minutes);
      const v = new Array(HEADERS.length).fill('');
      Object.assign(v, {
        [K.created]: nowStr_(), [K.id]: `MH-${b.date.slice(5, 7)}${b.date.slice(8, 10)}-${Math.floor(Math.random() * 9000) + 1000}`,
        [K.date]: b.date, [K.start]: toHHMM_(start), [K.end]: toHHMM_(start + q.minutes), [K.duration]: String(q.minutes),
        [K.stylist]: stylist.name, [K.services]: q.svcs.map(s => s.th).join(', '), [K.length]: len, [K.price]: String(q.price),
        [K.deposit]: '0', [K.depositStatus]: DEPOSIT.NONE, [K.status]: STATUS.CONFIRMED, [K.name]: name,
        [K.phone]: String(b.phone || '').replace(/\D/g, ''), [K.pronoun]: 'ไม่ระบุ', [K.note]: String(b.note || '').slice(0, 300),
        [K.channel]: b.channel === 'โทรจอง' ? 'โทรจอง' : 'Walk-in',
      });
      appendRow_(v);
    } finally {
      lock.releaseLock();
    }
    return { ok: true };
  }
  if (b.action === 'admin_report') {
    if (!re.test(b.from) || !re.test(b.to)) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
    return {
      ok: true, config: publicConfig_(),
      bookings: rows_().filter(r => r.v[K.date] >= b.from && r.v[K.date] <= b.to).map(r => toBooking_(r.v, true)),
    };
  }
  throw new Error('unknown admin action');
}

// ---------- Flex message ----------

function confirmFlex_(b, headline) {
  const row = (k, v) => ({
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: k, size: 'sm', color: '#6B7686', flex: 2 },
      { type: 'text', text: v || '-', size: 'sm', color: '#1B2533', flex: 5, wrap: true },
    ],
  });
  const deposit = b.deposit > 0 ? `฿${b.deposit} · ${b.depositStatus}` : b.depositStatus;
  return {
    type: 'flex', altText: `${headline} · ${thaiDate_(b.date)} ${b.start} น.`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1E2B3C', paddingAll: '18px', spacing: 'sm', contents: [
          { type: 'image', url: SITE + 'assets/logo-dark.png', size: 'full', aspectRatio: '4:1', aspectMode: 'fit' },
          { type: 'text', text: '✓ ' + headline, color: '#9DB7D5', size: 'xs', align: 'center', weight: 'bold' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '20px', contents: [
          { type: 'text', text: thaiDate_(b.date), size: 'xxl', weight: 'bold', color: '#1B2533' },
          { type: 'text', text: `${b.start} – ${b.end} น.`, size: 'lg', weight: 'bold', color: '#5A7FA8' },
          { type: 'separator', margin: 'lg' },
          { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: [
            row('ช่าง', b.stylist), row('บริการ', b.services), row('มัดจำ', deposit), row('รหัส', b.id)] },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#5A7FA8', height: 'sm', action: { type: 'uri', label: 'ดูนัด · VIEW', uri: LIFF_URL + '?page=my' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: 'ข้อมูลร้าน', uri: LIFF_URL + '?page=about' } },
        ],
      },
    },
  };
}

// ---------- PromptPay (EMVCo) ----------

function promptPayPayload_(id, amount) {
  const f = (tag, val) => tag + String(val.length).padStart(2, '0') + val;
  const digits = String(id).replace(/\D/g, '');
  const target = digits.length >= 13 ? f('02', digits) : f('01', ('0000000000000' + digits.replace(/^0/, '66')).slice(-13));
  let p = f('00', '01') + f('01', '12') + f('29', f('00', 'A000000677010111') + target) +
    f('53', '764') + f('54', Number(amount).toFixed(2)) + f('58', 'TH') + '6304';
  let crc = 0xFFFF;
  for (let i = 0; i < p.length; i++) {
    crc ^= p.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xFFFF;
  }
  return p + crc.toString(16).toUpperCase().padStart(4, '0');
}

// ---------- sheet helpers ----------

function sheet_() { return SpreadsheetApp.getActive().getSheetByName(SHEET); }

function rows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues().map((v, i) => ({ row: i + 2, v }));
}

function appendRow_(v) {
  const sh = sheet_();
  const range = sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length);
  range.setNumberFormat('@').setValues([v]);
}

function setCells_(row, cells) {
  const sh = sheet_();
  Object.keys(cells).forEach(k => sh.getRange(row, Number(k) + 1).setNumberFormat('@').setValue(cells[k]));
}

function toBooking_(v, admin) {
  const b = {
    id: v[K.id], date: v[K.date], start: v[K.start], end: v[K.end], duration: Number(v[K.duration]),
    stylist: v[K.stylist], services: v[K.services], length: v[K.length], price: Number(v[K.price]),
    deposit: Number(v[K.deposit]), depositStatus: v[K.depositStatus], status: v[K.status], name: v[K.name],
    visit: Number(v[K.visit]) || 0, channel: v[K.channel],
  };
  if (admin) {
    Object.assign(b, {
      created: v[K.created], phone: v[K.phone], pronoun: v[K.pronoun], chem: v[K.chem], note: v[K.note],
      photos: v[K.photos] ? v[K.photos].split(' ') : [], slip: v[K.slip], arrived: v[K.arrived],
      started: v[K.started], finished: v[K.finished], cancelled: v[K.cancelled],
    });
  }
  return b;
}

function hoursUntil_(b) {
  const [y, m, d] = b.date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0) + (toMin_(b.start) - 7 * 60) * 60000); // Asia/Bangkok = UTC+7
  return (start - Date.now()) / 3600000;
}

function thaiDate_(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${days[dt.getUTCDay()]} ${d} ${months[m - 1]}`;
}

/** dataURL (image/*) → ไฟล์ส่วนตัวใน Drive ของร้าน คืนลิงก์ */
function saveUpload_(dataUrl, name) {
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('ไฟล์รูปไม่ถูกต้อง');
  const bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > 2.5 * 1024 * 1024) throw new Error('รูปใหญ่เกินไป');
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID'));
  return folder.createFile(Utilities.newBlob(bytes, m[1], `${name}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`)).getUrl();
}

// ---------- LINE ----------

function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('missing idToken');
  const clientId = PropertiesService.getScriptProperties().getProperty('LOGIN_CHANNEL_ID');
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post', payload: { id_token: idToken, client_id: clientId }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('LINE login หมดอายุ กรุณาเปิดหน้าใหม่');
  return JSON.parse(res.getContentText()).sub;
}

function push_(to, messages) {
  try {
    lineApi_('https://api.line.me/v2/bot/message/push', 'post', JSON.stringify({ to, messages }), 'application/json');
  } catch (err) {
    console.error('push failed', err); // การจองสำเร็จแล้ว ไม่ให้ error ของ push ทำให้การจองล้ม
  }
}

function lineApi_(url, method, payload, contentType) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  const res = UrlFetchApp.fetch(url, {
    method, contentType, payload, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`LINE API ${res.getResponseCode()}: ${res.getContentText()}`);
  return res.getContentText();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
