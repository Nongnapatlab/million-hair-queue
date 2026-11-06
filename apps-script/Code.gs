/**
 * Million Hair Studio — LINE booking backend (Google Apps Script, bound to the Google Sheet)
 *
 * Script Properties (Project Settings → Script properties):
 *   LINE_TOKEN        Channel access token (long-lived) ของ Messaging API channel
 *   LOGIN_CHANNEL_ID  Channel ID ของ LINE Login channel (MillionHair Queue App)
 *   ADMIN_USER_IDS    LINE User ID ของแอดมิน คั่นด้วย ,
 *   PROMPTPAY_ID      (ไม่บังคับ) เบอร์/เลขบัตรสำหรับ QR มัดจำ — ว่างไว้ = โหมดสาธิต ไม่ต้องโอนจริง
 *   GEMINI_API_KEY    (ไม่บังคับ) API key ฟรีจาก Google AI Studio — ว่างไว้ = ปิดฟีเจอร์ AI (ตรวจสลิป / ประเมินทรง)
 *   GEMINI_MODEL      (ไม่บังคับ) ค่าเริ่มต้น gemini-3.5-flash-lite
 *   AI_AUTO_CONFIRM   (ไม่บังคับ) off = AI ตรวจแล้วแต่ให้แอดมินกดยืนยันเอง
 *
 * ติดตั้ง: รัน setup() ทุกครั้งที่อัปเดตโค้ด (หัวตาราง + trigger) · setupRichMenu() ครั้งเดียว
 */

const TZ = 'Asia/Bangkok';
const SHEET = 'Bookings';
const SITE = 'https://nongnapatlab.github.io/million-hair-queue/';
const LIFF_URL = 'https://liff.line.me/2012052973-UNW6H5DF';
const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('ซอยสุขุมวิท 49 คลองตันเหนือ วัฒนา กรุงเทพฯ');

// ---------- ข้อมูลร้าน (ร้านสมมติสำหรับโครงงาน) ----------
const SHOP = {
  name: 'Million Hair Studio',
  hours: 'เปิด 10:00–20:00 · ปิดทุกวันพุธ',
  address: 'ซอยสุขุมวิท 49 คลองตันเหนือ วัฒนา กรุงเทพฯ · BTS พร้อมพงษ์ เดินต่อประมาณ 10 นาที',
  phone: '[เบอร์ร้านสมมติ]',
  open: 10 * 60, close: 20 * 60, closedDays: [3], // 0=อา … 3=พ
  slotStep: 30, leadMin: 30, daysAhead: 14,
  deposit: 300, holdMin: 30, // กันคิวไว้ 30 นาทีระหว่างรอมัดจำ
  // จองแบบยืดหยุ่น: ลูกค้าเลือกแค่ช่วง ระบบจัดเวลาจริงให้ชิดคิวที่มีอยู่ (ลดช่องว่างของช่าง)
  windows: [
    { id: 'morning', th: 'ช่วงเช้า', en: 'MORNING', from: 10 * 60, to: 13 * 60 },
    { id: 'afternoon', th: 'ช่วงบ่าย', en: 'AFTERNOON', from: 13 * 60, to: 17 * 60 },
    { id: 'evening', th: 'ช่วงเย็น', en: 'EVENING', from: 17 * 60, to: 20 * 60 },
  ],
  mapUrl: MAP_URL,
};
const LENGTHS = [
  { code: 'S', th: 'สั้น' }, { code: 'M', th: 'ประบ่า' }, { code: 'L', th: 'ยาว' },
  { code: 'XL', th: 'ยาวมาก', note: 'ผมยาวพิเศษหรือหนามาก ช่างจะประเมินราคาให้ก่อนเริ่มงาน' },
];
// ราคาตามความยาวผม S / M / L (XL ใช้ราคา L แล้วช่างประเมินเพิ่มหน้างาน) · ไม่แบ่งตามเพศ
const SERVICES = [
  { id: 'cut', th: 'ตัดผม', en: 'HAIRCUT', min: 45, prices: { S: 500, M: 500, L: 600 }, rebookDays: 35 },
  { id: 'wash', th: 'สระ-ไดร์', en: 'WASH & BLOW-DRY', min: 30, prices: { S: 350, M: 400, L: 500 } },
  { id: 'color', th: 'ทำสี', en: 'COLOR', min: 120, prices: { S: 1800, M: 2500, L: 3200 }, rebookDays: 56 },
  { id: 'bleach', th: 'ไฮไลท์-บลีช', en: 'HIGHLIGHT & BLEACH', min: 180, prices: { S: 2500, M: 3500, L: 4500 }, rebookDays: 56 },
  { id: 'perm', th: 'ดัด', en: 'PERM', min: 150, prices: { S: 2000, M: 2800, L: 3500 } },
  { id: 'straight', th: 'ยืด', en: 'STRAIGHTENING', min: 180, prices: { S: 2500, M: 3200, L: 4000 } },
  { id: 'treat', th: 'ทรีตเมนต์', en: 'TREATMENT', min: 45, prices: { S: 800, M: 1000, L: 1200 } },
  { id: 'beard', th: 'แต่งหนวด', en: 'BEARD TRIM', min: 20, prices: { S: 300, M: 300, L: 300 } },
  { id: 'ext', th: 'ต่อผม', en: 'HAIR EXTENSIONS', min: 180, prices: { S: 5000, M: 5000, L: 5000 }, from: true },
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
  PENDING: 'รอมัดจำ', CONFIRMED: 'ยืนยันแล้ว', ARRIVED: 'มาถึงแล้ว', SERVING: 'รับบริการ',
  DONE: 'เสร็จสิ้น', NO_SHOW: 'ไม่มา', CANCELLED: 'ยกเลิก',
};
const ACTIVE = [STATUS.PENDING, STATUS.CONFIRMED, STATUS.ARRIVED, STATUS.SERVING];
const DEPOSIT = { UNPAID: 'ยังไม่ชำระ', SLIP: 'แนบสลิปแล้ว · รอตรวจ', PAID: 'ชำระแล้ว', NONE: 'ไม่เก็บมัดจำ' };

// ---------- ข้อความ LINE (น้ำเสียงกลาง ไม่ใช้ ครับ/ค่ะ) · {ชื่อ} {วันที่} {เวลา} {ช่าง} {บริการ} {รหัสจอง} {ลิงก์จอง} ----------
const MSG = {
  pending: 'ได้รับคำขอจองแล้ว {ชื่อ}\n\n{วันที่} · {เวลา} น.{ช่วงเวลา}\nช่าง {ช่าง} · {บริการ}\n\nโอนมัดจำ ฿300 ผ่าน PromptPay แล้วแนบสลิปภายใน 30 นาที เพื่อล็อกคิวนี้ไว้\nรหัสจอง {รหัสจอง}',
  confirmed: 'จองสำเร็จ ✓ เจอกัน {วันที่} เวลา {เวลา} น.{ช่วงเวลา}\nช่าง {ช่าง} · {บริการ}\nรหัสจอง {รหัสจอง}\n\nเลื่อนนัดได้ฟรีก่อน 24 ชม. ผ่านเมนู MY BOOKING',
  reminderD1: 'พรุ่งนี้เจอกัน {ชื่อ} ✦\n{วันที่} · {เวลา} น. กับ {ช่าง}\n\nถ้ามีรูปทรงที่อยากได้เพิ่ม ส่งมาในแชทนี้ได้เลย ช่างจะได้เตรียมก่อน',
  reminder2h: 'อีก 2 ชั่วโมงถึงคิวของ {ชื่อ} ({เวลา} น.)\nร้านอยู่ซอยสุขุมวิท 49 ใกล้ BTS พร้อมพงษ์\nมาถึงก่อน 5–10 นาทีกำลังดี',
  rescheduled: 'เปลี่ยนนัดให้แล้ว\nใหม่: {วันที่} · {เวลา} น. กับ {ช่าง}\n\nมัดจำเดิมยังใช้ได้ตามปกติ',
  cancelled: 'ยกเลิกนัด {วันที่} {เวลา} น. แล้ว\n\nยกเลิกก่อน 24 ชม. คืนมัดจำภายใน 3 วันทำการ\nยกเลิกน้อยกว่า 24 ชม. ขอเก็บมัดจำไว้ตามเงื่อนไข\n\nพร้อมเมื่อไหร่ จองใหม่ได้ที่ {ลิงก์จอง}',
  expired: 'คำขอจอง {วันที่} {เวลา} น. หมดเวลาแนบสลิปมัดจำแล้ว คิวนี้จึงถูกปล่อยให้คนอื่นจอง\n\nจองใหม่ได้ตลอดที่ {ลิงก์จอง}',
  afterVisit: 'ขอบคุณที่มาหา Million วันนี้ {ชื่อ} ✦\n\nทรงใหม่เป็นยังไงบ้าง? ให้คะแนนช่าง {ช่าง} ได้ที่ปุ่มด้านล่าง ใช้เวลาไม่ถึง 30 วินาที\n\nทิป: งดสระ 48 ชม. หลังทำเคมี สีจะติดทนกว่า',
  rebook: 'ทรงเริ่มยาวแล้วหรือยัง {ชื่อ}?\n\n{ช่าง} มีคิวว่างสัปดาห์นี้\nกดจองซ้ำ จะได้บริการและช่างคนเดิมทันที',
};

// ---------- บัตรสะสมแต้ม: 1 แต้มทุกยอด ฿500 · ครบ 5 ทรีตเมนต์ฟรี · ครบ 10 ตัดผมฟรี (แล้วเริ่มบัตรใหม่) ----------
const LOYALTY = {
  bahtPerPoint: 500, cardSize: 10, validMonths: 12,
  rewards: [
    { id: 'treat', at: 5, th: 'ทรีตเมนต์ฟรี 1 ครั้ง', en: 'FREE TREATMENT', value: 'มูลค่า ฿800' },
    { id: 'cut', at: 10, th: 'ตัดผมฟรี 1 ครั้ง', en: 'FREE HAIRCUT', value: 'มูลค่า ฿500–600' },
  ],
};
const POINTS_SHEET = 'Points';
const POINTS_HEADERS = ['Timestamp', 'LINE User ID', 'Name', 'Type', 'Points', 'Booking ID', 'Reward', 'Code', 'Status', 'Used At', 'Card No'];
const P = {}; ['ts', 'uid', 'name', 'type', 'points', 'bookingId', 'reward', 'code', 'status', 'usedAt', 'card'].forEach((k, i) => { P[k] = i; });
const MEMBERS_SHEET = 'Members';
const MEMBERS_HEADERS = ['LINE User ID', 'Member No', 'Name', 'Joined'];

// ---------- งานทีม (ใช้ในหน้าหลังบ้าน) ----------
const TASKS_SHEET = 'Tasks';
const TASK_HEADERS = ['ID', 'Phase', 'Owner', 'Title', 'Due', 'Done', 'Done By', 'Done At'];
const PHASES = ['18–20 ต.ค. · ระบบพร้อม + เช็กตัวเลข', '21–23 ต.ค. · ความคืบหน้าครั้งที่ 2',
  '23–30 ต.ค. · ทดสอบร้านจำลอง + ความคืบหน้าครั้งที่ 3', '31 ต.ค.–6 พ.ย. · เตรียมนำเสนอจริง'];
const DEFAULT_TASKS = [ // [phase index, owner, title, due]
  [0, 'ney', 'อัปเดต Apps Script เวอร์ชันล่าสุด → Run setup → Deploy New version', '2026-10-18'],
  [0, 'ney', 'ตั้ง 5 ข้อความใน OA Manager (ทักทาย, จอง, ราคา, ที่อยู่, นอกเวลา)', '2026-10-19'],
  [0, 'ney', 'ทดสอบครบ 1 รอบ: รอมัดจำ → ยืนยัน → เสร็จสิ้น → แต้ม → ตอบ “ราคา”', '2026-10-20'],
  [0, 'ney', 'เพิ่มเพื่อนเป็นแอดมิน + แชร์ Google Sheet และ OA Manager', '2026-10-20'],
  [0, 'pom', 'รับคำเชิญ GitHub (Sauciiees)', '2026-10-18'],
  [0, 'pom', 'สำรวจราคาร้านทำผมแถวสุขุมวิท 3–5 ร้าน เทียบกับตารางราคาของเรา', '2026-10-20'],
  [0, 'pom', 'หาแหล่งอ้างอิง: ราคาแผน LINE OA ปัจจุบัน และอัตรา no-show ร้านทำผม', '2026-10-20'],
  [0, 'claude', 'แก้สไลด์ให้ตรงระบบล่าสุด: ราคาใหม่, 5 ข้อความ/นัด, ระบบแต้มย้ายมา “ทำแล้ว”', '2026-10-20'],
  [1, 'ney', 'ซ้อมเดโมสด: จอง → Flex ในแชต → หลังบ้าน → แต้ม', '2026-10-22'],
  [1, 'ney', 'เดโมสดในห้อง', '2026-10-23'],
  [1, 'pom', 'ทบทวนสไลด์ฝั่งธุรกิจ (หน้า 2–7, 13–15) และเขียนบทพูด', '2026-10-22'],
  [1, 'pom', 'นำเสนอสไลด์ความคืบหน้าครั้งที่ 2', '2026-10-23'],
  [1, 'claude', 'ทำแบบฟอร์มจับเวลาการจอง และแบบสอบถามความพึงพอใจ', '2026-10-22'],
  [2, 'ney', 'เล่นเป็นร้าน: ยืนยันมัดจำ กดสถานะ มาถึง/เริ่ม/เสร็จ/ไม่มา ทุกนัด', '2026-10-29'],
  [2, 'ney', 'Export CSV รายงานย้อนหลัง 7 วัน ส่งให้ Claude', '2026-10-30'],
  [2, 'pom', 'ชวนเพื่อน 15–20 คนจองจริงในระบบ', '2026-10-29'],
  [2, 'pom', 'จับเวลา: จองผ่านแชตกับแอดมิน เทียบกับจองผ่าน LINE', '2026-10-29'],
  [2, 'pom', 'ชวนให้คะแนนหลังใช้บริการ + แจกแบบสอบถาม', '2026-10-29'],
  [2, 'pom', 'สรุปตาราง KPI ก่อน/หลัง และนำเสนอความคืบหน้าครั้งที่ 3', '2026-10-30'],
  [2, 'claude', 'ใส่ตัวเลขจริงจาก CSV แทนสมมติฐานในสไลด์', '2026-10-30'],
  [3, 'ney', 'อัดคลิปเดโมสำรอง กันเน็ตล่มวันนำเสนอ', '2026-11-04'],
  [3, 'ney', 'เดโมสดวันนำเสนอ', '2026-11-06'],
  [3, 'pom', 'พิมพ์บัตรสะสมแต้มตัวอย่าง 2–3 ใบไว้ถือโชว์', '2026-11-04'],
  [3, 'pom', 'เตรียมคำตอบคำถามอาจารย์ (ตัวเลขสมมติมาจากไหน, ทำไมมัดจำ ฿300)', '2026-11-05'],
  [3, 'pom', 'นำเสนอ', '2026-11-06'],
  [3, 'claude', 'ซ้อมถาม-ตอบ และเก็บรายละเอียดสไลด์ฉบับสุดท้าย', '2026-11-05'],
];

const HEADERS = ['Created At', 'Booking ID', 'Date', 'Start', 'End', 'Duration', 'Stylist', 'Services',
  'Hair Length', 'Est. Price', 'Deposit', 'Deposit Status', 'Status', 'Name', 'Phone', 'Pronoun',
  'Chemical History', 'Note', 'Ref Photos', 'Slip', 'LINE User ID', 'Visit No', 'Arrived At',
  'Started At', 'Finished At', 'Cancelled At', 'Reminder D-1', 'Channel',
  'Confirmed At', 'Reminder 2h', 'After Visit Sent', 'Rebook Sent', 'Rating', 'Review',
  'Time Window', 'AI Estimate', 'AI Slip Check', 'Slip Ref'];
const K = {}; // ชื่อ field → index (0-based)
['created', 'id', 'date', 'start', 'end', 'duration', 'stylist', 'services', 'length', 'price', 'deposit',
  'depositStatus', 'status', 'name', 'phone', 'pronoun', 'chem', 'note', 'photos', 'slip', 'uid', 'visit',
  'arrived', 'started', 'finished', 'cancelled', 'reminded', 'channel',
  'confirmedAt', 'reminded2h', 'afterSent', 'rebookSent', 'rating', 'review',
  'window', 'aiEstimate', 'aiSlip', 'slipRef'].forEach((k, i) => { K[k] = i; });

// ---------- setup ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET, 0);
  if (sh.getMaxColumns() < HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#1E2B3C').setFontColor('#F6F6F4');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, sh.getMaxRows() - 1, HEADERS.length).setNumberFormat('@'); // เก็บทุกอย่างเป็นข้อความ
  sh.hideColumns(K.uid + 1);

  [[POINTS_SHEET, POINTS_HEADERS, P.uid], [MEMBERS_SHEET, MEMBERS_HEADERS, 0], [TASKS_SHEET, TASK_HEADERS, -1]].forEach(([name, headers, hideCol]) => {
    const s = ss.getSheetByName(name) || ss.insertSheet(name);
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1E2B3C').setFontColor('#F6F6F4');
    s.setFrozenRows(1);
    s.getRange(2, 1, s.getMaxRows() - 1, headers.length).setNumberFormat('@');
    if (hideCol >= 0) s.hideColumns(hideCol + 1);
  });
  seedTasks_();

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('UPLOAD_FOLDER_ID')) {
    props.setProperty('UPLOAD_FOLDER_ID', DriveApp.createFolder('Million Hair Uploads (ส่วนตัว)').getId());
  }

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(18).inTimezone(TZ).create();
  ScriptApp.newTrigger('rebookNudge').timeBased().everyDays(1).atHour(10).inTimezone(TZ).create();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(10).create();
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
      case 'slip': return json_(attachSlip_(uid, body));
      case 'rate': return json_(rate_(uid, body));
      case 'last': return json_(lastProfile_(uid));
      case 'points': return json_({ ok: true, ...pointsOf_(uid) });
      case 'redeem': return json_(redeem_(uid, body.reward));
      case 'ai_estimate': return json_(aiEstimate_(uid, body));
      default:
        if (String(body.action).startsWith('admin_')) return json_(admin_(uid, body));
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function publicConfig_() {
  const pp = PropertiesService.getScriptProperties().getProperty('PROMPTPAY_ID');
  return {
    ok: true, shop: SHOP, lengths: LENGTHS, services: SERVICES, stylists: STYLISTS, loyalty: LOYALTY,
    chemicals: CHEMICALS, pronouns: PRONOUNS, dates: bookableDates_(),
    ai: Boolean(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')),
    promptpay: pp ? promptPayPayload_(pp, SHOP.deposit) : null,
  };
}

// ---------- pricing / time helpers ----------

const priceOf_ = (svc, len) => svc.prices[len === 'XL' ? 'L' : (svc.prices[len] ? len : 'M')];
const toMin_ = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const toHHMM_ = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const nowStr_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
const todayStr_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
const nowMin_ = () => toMin_(Utilities.formatDate(new Date(), TZ, 'HH:mm'));
/** 'yyyy-MM-dd HH:mm:ss' (เวลาไทย) → epoch ms */
const tsMs_ = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5]) : NaN;
};
const startMs_ = b => tsMs_(`${b.date} ${b.start}`);

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
  const earliest = date === todayStr_() ? nowMin_() + SHOP.leadMin : 0;

  const slots = [];
  for (let t = SHOP.open; t + minutes <= SHOP.close; t += SHOP.slotStep) {
    const free = t >= earliest && ids.some(id => isFree_(busy[id], t, t + minutes));
    slots.push({ time: toHHMM_(t), free });
  }
  const windows = SHOP.windows.map(w => ({ id: w.id, free: Boolean(bestFit_(busy, ids, w, minutes, earliest)) }));
  return { ok: true, date, closed: false, minutes, slots, windows };
}

/**
 * จัดเวลาให้คิวแบบยืดหยุ่น: ลองทุกเวลาเริ่มในช่วงที่เลือก กับช่างทุกคนที่ว่าง
 * เลือกเวลาที่ชิดนัดเดิม (หรือชิดเวลาเปิด-ปิดร้าน) มากที่สุด เพื่อไม่ให้เกิดช่องว่างสั้น ๆ ที่ขายไม่ได้
 * เสมอกัน → ช่างที่มีนัดน้อยกว่า → เวลาที่เร็วกว่า
 */
function bestFit_(busy, ids, win, minutes, earliest) {
  let best = null;
  const from = Math.max(win.from, Math.ceil(earliest / SHOP.slotStep) * SHOP.slotStep);
  ids.forEach(id => {
    const ranges = busy[id] || [];
    for (let t = from; t < win.to && t + minutes <= SHOP.close; t += SHOP.slotStep) {
      if (!isFree_(ranges, t, t + minutes)) continue;
      const before = t - Math.max(SHOP.open, ...ranges.filter(([, e]) => e <= t).map(([, e]) => e));
      const after = Math.min(SHOP.close, ...ranges.filter(([s]) => s >= t + minutes).map(([s]) => s)) - (t + minutes);
      const score = [Math.min(before, after, 60), ranges.length, t]; // ช่องว่าง ≥ 60 นาทียังขายได้ ถือว่าเท่ากัน
      if (!best || compare_(score, best.score) < 0) best = { id, start: t, score };
    }
  });
  return best;
}
const compare_ = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

function busyMap_(date, excludeId) {
  const map = {};
  STYLISTS.forEach(s => { map[s.id] = []; });
  rows_().forEach(r => {
    if (r.v[K.date] !== date || !ACTIVE.concat([STATUS.DONE, STATUS.NO_SHOW]).includes(r.v[K.status]) || r.v[K.id] === excludeId) return;
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

function validateSlot_(date, time, minutes, allowPast) {
  const day = bookableDates_().find(d => d.date === date);
  if (!allowPast && (!day || day.closed)) throw new Error('วันนี้ร้านปิดหรืออยู่นอกช่วงที่จองได้');
  const start = toMin_(time);
  if (!(start >= SHOP.open && start + minutes <= SHOP.close)) throw new Error('เวลาไม่อยู่ในช่วงเปิดร้าน');
  if (!allowPast && date === todayStr_() && start < nowMin_() + SHOP.leadMin) throw new Error('เวลานี้ผ่านไปแล้ว');
  return start;
}

const newId_ = date => `MH-${date.slice(5, 7)}${date.slice(8, 10)}-${Math.floor(Math.random() * 9000) + 1000}`;

// ---------- customer actions ----------

function book_(uid, b) {
  const name = String(b.name || '').trim().slice(0, 50);
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (!name) throw new Error('กรุณากรอกชื่อเล่น');
  if (!/^0\d{8,9}$/.test(phone)) throw new Error('กรุณากรอกเบอร์โทรให้ถูกต้อง');
  if (b.consent !== true) throw new Error('ต้องยินยอมให้เก็บข้อมูลก่อนจอง');
  const len = LENGTHS.some(l => l.code === b.length) ? b.length : 'M';
  const q = quote_(b.services, len);
  // ผลประเมิน AI ที่ลูกค้ากดใช้: บวกเวลาเผื่อตามสภาพผม (จำกัด 0–90 นาที) · ราคายังมาจากตารางราคาเสมอ
  const ai = b.ai && typeof b.ai === 'object' ? b.ai : null;
  const extra = ai ? Math.min(90, Math.max(0, Math.round(Number(ai.extraMinutes) / 15) * 15 || 0)) : 0;
  q.minutes += extra;
  const win = b.window ? SHOP.windows.find(w => w.id === b.window) : null;
  if (b.window && !win) throw new Error('ช่วงเวลาไม่ถูกต้อง');
  let start = win ? null : validateSlot_(b.date, b.time, q.minutes);
  if (win) bookableDay_(b.date);

  const slipUrl = b.slip ? saveUpload_(b.slip, `slip_${b.date}_${name}`) : '';
  const photoUrls = (b.photos || []).slice(0, 3).map((p, i) => saveUpload_(p, `ref_${b.date}_${name}_${i + 1}`));

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let rec;
  try {
    let stylist;
    if (win) {
      const ids = b.stylist && b.stylist !== 'any' ? [b.stylist] : STYLISTS.map(s => s.id);
      const earliest = b.date === todayStr_() ? nowMin_() + SHOP.leadMin : 0;
      const fit = bestFit_(busyMap_(b.date), ids, win, q.minutes, earliest);
      if (!fit) throw new Error(`${win.th}ของวันนี้เต็มแล้ว ลองช่วงอื่นหรือเลือกช่าง Any`);
      start = fit.start;
      stylist = STYLISTS.find(s => s.id === fit.id);
    } else {
      stylist = pickStylist_(b.date, b.stylist, start, q.minutes);
    }
    const visit = rows_().filter(r => r.v[K.uid] === uid && r.v[K.status] !== STATUS.CANCELLED).length + 1;
    const v = new Array(HEADERS.length).fill('');
    Object.assign(v, {
      [K.created]: nowStr_(), [K.id]: newId_(b.date), [K.date]: b.date, [K.start]: toHHMM_(start),
      [K.end]: toHHMM_(start + q.minutes), [K.duration]: String(q.minutes), [K.stylist]: stylist.name,
      [K.services]: q.svcs.map(s => s.th).join(' + '), [K.length]: len, [K.price]: String(q.price),
      [K.deposit]: String(SHOP.deposit), [K.depositStatus]: slipUrl ? DEPOSIT.SLIP : DEPOSIT.UNPAID,
      [K.status]: STATUS.PENDING, [K.name]: name, [K.phone]: phone,
      [K.pronoun]: PRONOUNS.includes(b.pronoun) ? b.pronoun : 'ไม่ระบุ',
      [K.chem]: (b.chemicals || []).filter(c => CHEMICALS.includes(c)).join(', '),
      [K.note]: String(b.note || '').slice(0, 300), [K.photos]: photoUrls.join(' '), [K.slip]: slipUrl,
      [K.uid]: uid, [K.visit]: String(visit), [K.channel]: 'LINE', [K.window]: win ? win.id : '',
      [K.aiEstimate]: ai ? `${String(ai.summary || '').slice(0, 300)}${extra ? ` · เผื่อเวลา +${extra} นาที` : ''}` : '',
    });
    appendRow_(v);
    rec = toBooking_(v);
  } finally {
    lock.releaseLock();
  }
  // ยังไม่แนบสลิป → ส่งข้อความรอมัดจำ · แนบแล้ว → AI ตรวจสลิป ผ่าน = ยืนยันทันที ไม่ผ่าน = รอร้านตรวจ
  if (!slipUrl) {
    push_(uid, [card_(MSG.pending, rec, [['แนบสลิป', LIFF_URL + '?page=my']])]);
    return { ok: true, booking: rec };
  }
  return { ok: true, ...checkSlip_(rec.id, b.slip) };
}

function bookableDay_(date) {
  const day = bookableDates_().find(d => d.date === date);
  if (!day || day.closed) throw new Error('วันนี้ร้านปิดหรืออยู่นอกช่วงที่จองได้');
  return true;
}

function attachSlip_(uid, b) {
  const r = findOwn_(uid, b.id);
  if (r.v[K.status] !== STATUS.PENDING) throw new Error('นัดนี้ไม่ได้รอมัดจำแล้ว');
  const url = saveUpload_(b.slip, `slip_${r.v[K.date]}_${r.v[K.name]}`);
  setCells_(r.row, { [K.slip]: url, [K.depositStatus]: DEPOSIT.SLIP });
  return { ok: true, ...checkSlip_(r.v[K.id], b.slip) };
}

function rate_(uid, b) {
  const r = findOwn_(uid, b.id);
  const score = Math.round(Number(b.rating));
  if (!(score >= 1 && score <= 5)) throw new Error('กรุณาเลือกคะแนน 1–5');
  setCells_(r.row, { [K.rating]: String(score), [K.review]: String(b.review || '').slice(0, 500) });
  return { ok: true };
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
    if (![STATUS.PENDING, STATUS.CONFIRMED].includes(r.v[K.status])) throw new Error('นัดนี้ยกเลิกไม่ได้แล้ว');
    setCells_(r.row, { [K.status]: STATUS.CANCELLED, [K.cancelled]: nowStr_() });
    const b = toBooking_(r.v);
    push_(uid, [card_(MSG.cancelled, b, [['จองใหม่', LIFF_URL + '?page=book']])]);
    return { ok: true, late: (startMs_(b) - Date.now()) / 3600000 < 24 };
  } finally {
    lock.releaseLock();
  }
}

function reschedule_(uid, b) {
  const r = findOwn_(uid, b.id);
  return moveBooking_(r, b.date, b.time, false);
}

function moveBooking_(r, date, time, byShop) {
  if (![STATUS.PENDING, STATUS.CONFIRMED].includes(r.v[K.status])) throw new Error('นัดนี้เลื่อนไม่ได้แล้ว');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let rec;
  try {
    const minutes = Number(r.v[K.duration]);
    const start = validateSlot_(date, time, minutes, byShop);
    const wanted = (STYLISTS.find(s => s.name === r.v[K.stylist]) || {}).id;
    let stylist;
    try { stylist = pickStylist_(date, wanted, start, minutes, r.v[K.id]); }
    catch (e) { stylist = pickStylist_(date, 'any', start, minutes, r.v[K.id]); }
    setCells_(r.row, { [K.date]: date, [K.start]: toHHMM_(start), [K.end]: toHHMM_(start + minutes),
      [K.stylist]: stylist.name, [K.reminded]: '', [K.reminded2h]: '', [K.window]: '' });
    rec = toBooking_(rows_().find(x => x.row === r.row).v);
  } finally {
    lock.releaseLock();
  }
  if (r.v[K.uid]) push_(r.v[K.uid], [card_(MSG.rescheduled, rec, [['ดูนัด', LIFF_URL + '?page=my']])]);
  return { ok: true, booking: rec };
}

function findOwn_(uid, id) {
  const r = rows_().find(x => x.v[K.id] === id && x.v[K.uid] === uid);
  if (!r) throw new Error('ไม่พบนัดนี้');
  return r;
}

// ---------- scheduled jobs ----------

/** 18:00 ทุกวัน: เตือนนัดพรุ่งนี้ */
function sendReminders() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd');
  rows_().forEach(r => {
    const v = r.v;
    if (v[K.date] !== tomorrow || v[K.status] !== STATUS.CONFIRMED || v[K.reminded] || !v[K.uid]) return;
    push_(v[K.uid], [card_(MSG.reminderD1, toBooking_(v), [['ดูนัด', LIFF_URL + '?page=my'], ['เลื่อนนัด', LIFF_URL + '?page=my']])]);
    setCells_(r.row, { [K.reminded]: nowStr_() });
  });
}

/** ทุก 10 นาที: ปล่อยคิวที่ไม่แนบสลิปใน 30 นาที · เตือนก่อน 2 ชม. · ขอบคุณหลังใช้บริการ 3 ชม. */
function tick() {
  const now = Date.now();
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  rows_().forEach(r => {
    const v = r.v, b = toBooking_(v);
    if (!v[K.uid]) return;
    if (v[K.status] === STATUS.PENDING && v[K.depositStatus] === DEPOSIT.UNPAID && now - tsMs_(v[K.created]) > SHOP.holdMin * 60000) {
      setCells_(r.row, { [K.status]: STATUS.CANCELLED, [K.cancelled]: nowStr_() });
      push_(v[K.uid], [card_(MSG.expired, b, [['จองใหม่', LIFF_URL + '?page=book']])]);
      return;
    }
    const toStart = startMs_(b) - now;
    // ช่วง 100–130 นาทีก่อนนัด (trigger ทุก 10 นาทีจะเจอ 1 ครั้ง) · นัดที่จองกระชั้นกว่านี้ไม่ต้องเตือน
    if (v[K.status] === STATUS.CONFIRMED && !v[K.reminded2h] && toStart > 100 * 60000 && toStart <= 130 * 60000) {
      push_(v[K.uid], [card_(MSG.reminder2h, b, [['เปิดแผนที่', SHOP.mapUrl]])]);
      setCells_(r.row, { [K.reminded2h]: nowStr_() });
    }
    if (v[K.status] === STATUS.DONE && !v[K.afterSent] && v[K.finished] && now - tsMs_(v[K.finished]) >= 3 * 3600000
        && now - tsMs_(v[K.finished]) < 48 * 3600000 && hour >= 9 && hour < 21) {
      push_(v[K.uid], [card_(MSG.afterVisit, b, [['ให้คะแนน', `${LIFF_URL}?page=rate&id=${encodeURIComponent(b.id)}`], ['ดูแต้ม', LIFF_URL + '?page=points']])]);
      setCells_(r.row, { [K.afterSent]: nowStr_() });
    }
  });
}

/** 10:00 ทุกวัน: ชวนกลับมาเติมทรง (ตัด 5 สัปดาห์ / ทำสี 8 สัปดาห์) ถ้ายังไม่มีนัดใหม่ */
function rebookNudge() {
  const all = rows_();
  const today = todayStr_();
  all.forEach(r => {
    const v = r.v;
    if (v[K.status] !== STATUS.DONE || v[K.rebookSent] || !v[K.uid]) return;
    const days = Math.max(0, ...SERVICES.filter(s => s.rebookDays && v[K.services].includes(s.th)).map(s => s.rebookDays));
    if (!days) return;
    const due = Utilities.formatDate(new Date(tsMs_(`${v[K.date]} 12:00`) + days * 86400000), TZ, 'yyyy-MM-dd');
    if (due > today) return;
    const hasNext = all.some(x => x.v[K.uid] === v[K.uid] && x.v[K.date] > v[K.date] && x.v[K.status] !== STATUS.CANCELLED);
    if (!hasNext) {
      push_(v[K.uid], [card_(MSG.rebook, toBooking_(v), [['จองซ้ำ', `${LIFF_URL}?page=rebook&id=${encodeURIComponent(v[K.id])}`]])]);
    }
    setCells_(r.row, { [K.rebookSent]: hasNext ? 'skip: มีนัดใหม่แล้ว' : nowStr_() });
  });
}

// ---------- loyalty ----------

function pointRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(POINTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, POINTS_HEADERS.length).getDisplayValues().map((v, i) => ({ row: i + 2, v }));
}

function appendTo_(sheetName, width, v) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  sh.getRange(sh.getLastRow() + 1, 1, 1, width).setNumberFormat('@').setValues([v]);
}

/** เลขสมาชิก 4 หลัก (ออกให้ครั้งแรกที่ได้แต้ม) */
function memberNo_(uid, name, create) {
  const sh = SpreadsheetApp.getActive().getSheetByName(MEMBERS_SHEET);
  const rows = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, MEMBERS_HEADERS.length).getDisplayValues();
  const found = rows.find(r => r[0] === uid);
  if (found || !create) return found ? found[1] : '';
  const no = String(rows.length + 1).padStart(4, '0');
  appendTo_(MEMBERS_SHEET, MEMBERS_HEADERS.length, [uid, no, name, nowStr_()]);
  return no;
}

/** ได้แต้มเมื่อร้านกดเสร็จสิ้น (ครั้งเดียวต่อนัด) คืนจำนวนแต้มที่ได้ */
function earnPoints_(v) {
  if (!v[K.uid] || pointRows_().some(r => r.v[P.type] === 'EARN' && r.v[P.bookingId] === v[K.id])) return 0;
  const pts = Math.floor(Number(v[K.price]) / LOYALTY.bahtPerPoint);
  if (pts <= 0) return 0;
  memberNo_(v[K.uid], v[K.name], true);
  const row = new Array(POINTS_HEADERS.length).fill('');
  Object.assign(row, { [P.ts]: nowStr_(), [P.uid]: v[K.uid], [P.name]: v[K.name], [P.type]: 'EARN',
    [P.points]: String(pts), [P.bookingId]: v[K.id], [P.reward]: v[K.services] });
  appendTo_(POINTS_SHEET, POINTS_HEADERS.length, row);
  return pts;
}

/** สรุปบัตรของลูกค้า: แต้มในบัตรปัจจุบัน รางวัลที่แลกได้ โค้ดที่รอใช้ และประวัติ */
function pointsOf_(uid, rowsCache) {
  const mine = (rowsCache || pointRows_()).filter(r => r.v[P.uid] === uid).map(r => r.v);
  const earned = mine.filter(v => v[P.type] === 'EARN').reduce((s, v) => s + Number(v[P.points]), 0);
  const redeems = mine.filter(v => v[P.type] === 'REDEEM');
  const cardsDone = redeems.filter(v => v[P.reward] === 'cut').length;
  const cardNo = cardsDone + 1;
  const current = earned - cardsDone * LOYALTY.cardSize;
  const lastEarn = mine.filter(v => v[P.type] === 'EARN').map(v => v[P.ts]).sort().pop();
  let exp = '';
  if (lastEarn) {
    const d = new Date(tsMs_(lastEarn));
    d.setUTCMonth(d.getUTCMonth() + LOYALTY.validMonths);
    exp = Utilities.formatDate(d, TZ, 'MM/yyyy');
  }
  const rewards = LOYALTY.rewards.map(rw => {
    const used = redeems.some(v => v[P.reward] === rw.id && Number(v[P.card]) === cardNo);
    return { ...rw, redeemed: used, available: !used && current >= rw.at, need: Math.max(0, rw.at - current) };
  });
  return {
    memberNo: memberNo_(uid), current, cardNo, earned, exp, rewards,
    vouchers: redeems.filter(v => v[P.status] === 'ใช้ได้').map(v => ({ code: v[P.code], reward: v[P.reward], ts: v[P.ts] })),
    history: mine.slice(-20).reverse().map(v => ({ ts: v[P.ts], type: v[P.type], points: Number(v[P.points]) || 0,
      detail: v[P.type] === 'EARN' ? v[P.reward] : (LOYALTY.rewards.find(r => r.id === v[P.reward]) || {}).th, status: v[P.status] })),
  };
}

function redeem_(uid, rewardId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const s = pointsOf_(uid);
    const rw = s.rewards.find(r => r.id === rewardId);
    if (!rw || !rw.available) throw new Error('ยังแลกรางวัลนี้ไม่ได้');
    const code = `RW-${Math.floor(Math.random() * 900000) + 100000}`;
    const name = (rows_().filter(r => r.v[K.uid] === uid).pop() || { v: [] }).v[K.name] || '';
    const row = new Array(POINTS_HEADERS.length).fill('');
    Object.assign(row, { [P.ts]: nowStr_(), [P.uid]: uid, [P.name]: name, [P.type]: 'REDEEM', [P.points]: '0',
      [P.reward]: rw.id, [P.code]: code, [P.status]: 'ใช้ได้', [P.card]: String(s.cardNo) });
    appendTo_(POINTS_SHEET, POINTS_HEADERS.length, row);
    return { ok: true, code, ...pointsOf_(uid) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- admin ----------

function admin_(uid, b) {
  const admins = (PropertiesService.getScriptProperties().getProperty('ADMIN_USER_IDS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!admins.includes(uid)) return { ok: false, error: 'NOT_ADMIN', userId: uid };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const find = id => { const r = rows_().find(x => x.v[K.id] === id); if (!r) throw new Error('ไม่พบนัด'); return r; };

  if (b.action === 'admin_day') {
    if (!re.test(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
    const day = rows_().filter(r => r.v[K.date] === b.date);
    const pr = pointRows_();
    const loyalty = {};
    day.forEach(r => { if (r.v[K.uid] && !loyalty[r.v[K.id]]) {
      const s = pointsOf_(r.v[K.uid], pr);
      loyalty[r.v[K.id]] = { memberNo: s.memberNo, current: s.current, vouchers: s.vouchers };
    } });
    return { ok: true, bookings: day.map(r => ({ ...toBooking_(r.v, true), loyalty: loyalty[r.v[K.id]] || null })), config: publicConfig_() };
  }
  if (b.action === 'admin_overview') {
    if (!re.test(b.from) || !re.test(b.to)) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
    const pr = pointRows_();
    const members = SpreadsheetApp.getActive().getSheetByName(MEMBERS_SHEET);
    const folderId = PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID');
    return {
      ok: true, config: publicConfig_(),
      bookings: rows_().filter(r => r.v[K.date] >= b.from && r.v[K.date] <= b.to).map(r => toBooking_(r.v, true)),
      loyalty: {
        members: members ? Math.max(0, members.getLastRow() - 1) : 0,
        pointsIssued: pr.filter(r => r.v[P.type] === 'EARN').reduce((s, r) => s + Number(r.v[P.points]), 0),
        vouchersOpen: pr.filter(r => r.v[P.type] === 'REDEEM' && r.v[P.status] === 'ใช้ได้').length,
        vouchersUsed: pr.filter(r => r.v[P.type] === 'REDEEM' && r.v[P.status] === 'ใช้แล้ว').length,
      },
      links: {
        sheet: SpreadsheetApp.getActive().getUrl(),
        script: `https://script.google.com/home/projects/${ScriptApp.getScriptId()}/edit`,
        uploads: folderId ? `https://drive.google.com/drive/folders/${folderId}` : '',
      },
    };
  }
  if (b.action === 'admin_tasks') return { ok: true, tasks: tasks_(), phases: PHASES };
  if (b.action === 'admin_task_set') {
    const t = taskRow_(b.id);
    const sh = SpreadsheetApp.getActive().getSheetByName(TASKS_SHEET);
    sh.getRange(t.row, 6, 1, 3).setNumberFormat('@').setValues([[b.done ? 'yes' : '', b.done ? String(b.by || '').slice(0, 40) : '', b.done ? nowStr_() : '']]);
    return { ok: true, tasks: tasks_() };
  }
  if (b.action === 'admin_task_add') {
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) throw new Error('กรุณาพิมพ์ชื่องาน');
    const owner = ['ney', 'pom', 'claude'].includes(b.owner) ? b.owner : 'ney';
    const phase = PHASES[Number(b.phase)] ? PHASES[Number(b.phase)] : PHASES[0];
    appendTo_(TASKS_SHEET, TASK_HEADERS.length, ['T' + Date.now().toString(36), phase, owner, title, re.test(b.due) ? b.due : '', '', '', '']);
    return { ok: true, tasks: tasks_() };
  }
  if (b.action === 'admin_task_delete') {
    SpreadsheetApp.getActive().getSheetByName(TASKS_SHEET).deleteRow(taskRow_(b.id).row);
    return { ok: true, tasks: tasks_() };
  }
  if (b.action === 'admin_use_voucher') {
    const r = pointRows_().find(x => x.v[P.code] === b.code && x.v[P.type] === 'REDEEM');
    if (!r || r.v[P.status] !== 'ใช้ได้') throw new Error('โค้ดนี้ใช้ไม่ได้');
    const sh = SpreadsheetApp.getActive().getSheetByName(POINTS_SHEET);
    sh.getRange(r.row, P.status + 1).setValue('ใช้แล้ว');
    sh.getRange(r.row, P.usedAt + 1).setNumberFormat('@').setValue(nowStr_());
    return { ok: true };
  }
  if (b.action === 'admin_set_status') {
    if (!Object.values(STATUS).includes(b.status)) throw new Error('สถานะไม่ถูกต้อง');
    const r = find(b.id);
    const stamp = { [STATUS.ARRIVED]: K.arrived, [STATUS.SERVING]: K.started, [STATUS.DONE]: K.finished, [STATUS.CANCELLED]: K.cancelled }[b.status];
    const cells = { [K.status]: b.status };
    if (stamp !== undefined && !r.v[stamp]) cells[stamp] = nowStr_();
    if (b.status === STATUS.SERVING && !r.v[K.arrived]) cells[K.arrived] = nowStr_();
    setCells_(r.row, cells);
    if (b.status === STATUS.DONE) return { ok: true, earned: earnPoints_(r.v) };
    if (b.status === STATUS.CANCELLED && r.v[K.uid]) {
      push_(r.v[K.uid], [card_(MSG.cancelled, toBooking_(r.v), [['จองใหม่', LIFF_URL + '?page=book']])]);
    }
    return { ok: true };
  }
  if (b.action === 'admin_confirm') { // ตรวจสลิป / รับมัดจำแล้ว → ยืนยันนัด + ส่ง Flex
    const r = find(b.id);
    if (r.v[K.status] !== STATUS.PENDING) throw new Error('นัดนี้ไม่ได้อยู่ในสถานะรอมัดจำ');
    confirm_(r);
    return { ok: true };
  }
  if (b.action === 'admin_ai_slip') { // ให้ AI ตรวจสลิปอีกครั้ง (เช่น ครั้งแรกโควตาเต็ม)
    const r = find(b.id);
    const fileId = (/\/d\/([\w-]+)/.exec(r.v[K.slip]) || [])[1];
    if (!fileId) throw new Error('นัดนี้ยังไม่มีสลิป');
    const blob = DriveApp.getFileById(fileId).getBlob();
    const res = checkSlip_(b.id, `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`);
    if (!res.aiSlip) throw new Error('ร้านยังไม่เปิดใช้ AI (ใส่ GEMINI_API_KEY ใน Script Properties)');
    return { ok: true, ...res };
  }
  if (b.action === 'admin_reschedule') {
    if (!re.test(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
    return moveBooking_(find(b.id), b.date, b.time, true);
  }
  if (b.action === 'admin_book') { // Walk-in / โทรจอง
    const name = String(b.name || '').trim().slice(0, 50);
    if (!name) throw new Error('กรุณากรอกชื่อ');
    if (!re.test(b.date)) throw new Error('วันที่ไม่ถูกต้อง');
    const len = LENGTHS.some(l => l.code === b.length) ? b.length : 'M';
    const q = quote_(b.services, len);
    const start = validateSlot_(b.date, b.time, q.minutes, true);
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const stylist = pickStylist_(b.date, b.stylist, start, q.minutes);
      const v = new Array(HEADERS.length).fill('');
      Object.assign(v, {
        [K.created]: nowStr_(), [K.id]: newId_(b.date), [K.date]: b.date, [K.start]: toHHMM_(start),
        [K.end]: toHHMM_(start + q.minutes), [K.duration]: String(q.minutes), [K.stylist]: stylist.name,
        [K.services]: q.svcs.map(s => s.th).join(' + '), [K.length]: len, [K.price]: String(q.price),
        [K.deposit]: '0', [K.depositStatus]: DEPOSIT.NONE, [K.status]: STATUS.CONFIRMED, [K.name]: name,
        [K.phone]: String(b.phone || '').replace(/\D/g, ''), [K.pronoun]: 'ไม่ระบุ', [K.note]: String(b.note || '').slice(0, 300),
        [K.channel]: b.channel === 'โทรจอง' ? 'โทรจอง' : 'Walk-in', [K.confirmedAt]: nowStr_(),
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

// ---------- AI (Gemini free tier) ----------

/** เรียก Gemini (Interactions API) พร้อมรูป แล้วคืน JSON ตาม schema · ไม่มี key → throw AI_OFF */
function gemini_(prompt, images, schema) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI_OFF');
  const input = [{ type: 'text', text: prompt }].concat(images.map(dataUrl => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
    if (!m) throw new Error('ไฟล์รูปไม่ถูกต้อง');
    return { type: 'image', mime_type: m[1], data: m[2] };
  }));
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
    payload: JSON.stringify({
      model: props.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash-lite', input, store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema },
    }),
  });
  const code = res.getResponseCode();
  if (code === 429) throw new Error('AI ใช้โควตาฟรีช่วงนี้ครบแล้ว');
  if (code >= 300) throw new Error(`Gemini ${code}: ${res.getContentText().slice(0, 200)}`);
  const d = JSON.parse(res.getContentText());
  const text = (d.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || [])
    .filter(c => c.type === 'text').map(c => c.text).join('');
  return JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, ''));
}

/** AI ประเมินทรงจากรูป: เลือกความยาว + บริการ + เวลาเผื่อ · ราคาคำนวณจากตารางราคาของร้านเท่านั้น */
function aiEstimate_(uid, b) {
  const photos = (b.photos || []).slice(0, 2);
  if (!photos.length) throw new Error('กรุณาแนบรูปผมปัจจุบันอย่างน้อย 1 รูป');
  const cache = CacheService.getScriptCache(), ck = 'ai_' + uid, used = Number(cache.get(ck) || 0);
  if (used >= 10) throw new Error('ใช้ AI ประเมินครบ 10 ครั้งต่อชั่วโมงแล้ว ลองใหม่ภายหลัง');
  cache.put(ck, String(used + 1), 3600);

  const chem = (b.chemicals || []).filter(c => CHEMICALS.includes(c));
  const prompt = `คุณเป็นช่างทำผมอาวุโสของร้าน ${SHOP.name} ประเมินงานจากรูป
รูปที่ 1 คือผมปัจจุบันของลูกค้า${photos.length > 1 ? ' · รูปที่ 2 คือทรงที่ลูกค้าอยากได้' : ''}
สิ่งที่ลูกค้าอยากได้: ${String(b.wish || '').slice(0, 300) || '(ไม่ได้ระบุ)'}
ทำเคมีใน 12 เดือน: ${chem.join(', ') || 'ไม่มี / ไม่ระบุ'}

length: S = สั้นถึงคาง · M = ประบ่า · L = ยาวเลยบ่า ถึงกลางหลัง · XL = ยาวเกินกลางหลังหรือหนามาก
services: เลือกเฉพาะ id จากรายการนี้ และเลือกเท่าที่จำเป็นเพื่อให้ได้ทรงที่ต้องการ
${SERVICES.map(s => `${s.id} = ${s.th} (มาตรฐาน ${s.min} นาที)`).join('\n')}
extraMinutes: เวลาที่ควรเผื่อเพิ่มจากเวลามาตรฐาน เพราะผมหนา ยาว หรือเสีย (0–90 ทวีคูณ 15)
reason: ภาษาไทย 1–2 ประโยค อธิบายสภาพผมและเหตุผลที่เลือก ไม่ต้องพูดถึงราคา
ถ้ารูปที่ 1 มองไม่เห็นผมชัด ให้ isHair = false`;
  const schema = {
    type: 'object', required: ['isHair', 'length', 'thickness', 'services', 'extraMinutes', 'confidence', 'reason'],
    properties: {
      isHair: { type: 'boolean' },
      length: { type: 'string', enum: LENGTHS.map(l => l.code) },
      thickness: { type: 'string', enum: ['บาง', 'ปกติ', 'หนา'] },
      services: { type: 'array', items: { type: 'string', enum: SERVICES.map(s => s.id) } },
      extraMinutes: { type: 'integer' },
      confidence: { type: 'string', enum: ['สูง', 'กลาง', 'ต่ำ'] },
      reason: { type: 'string' },
    },
  };
  let x;
  try { x = gemini_(prompt, photos, schema); }
  catch (err) { throw new Error(err.message === 'AI_OFF' ? 'ร้านยังไม่เปิดใช้ AI' : err.message); }
  if (!x.isHair) throw new Error('มองไม่เห็นผมชัด ลองถ่ายใหม่ให้เห็นทั้งศีรษะในที่สว่าง');

  const len = LENGTHS.some(l => l.code === x.length) ? x.length : 'M';
  const ids = SERVICES.map(s => s.id).filter(id => (x.services || []).includes(id));
  if (!ids.length) ids.push('cut');
  const extra = Math.min(90, Math.max(0, Math.round(Number(x.extraMinutes) / 15) * 15 || 0));
  const q = quote_(ids, len);
  const thickness = ['บาง', 'ปกติ', 'หนา'].includes(x.thickness) ? x.thickness : 'ปกติ';
  return {
    ok: true,
    estimate: {
      length: len, thickness, services: ids, extraMinutes: extra, minutes: q.minutes + extra, price: q.price,
      confidence: x.confidence || 'กลาง', reason: String(x.reason || '').slice(0, 300),
      summary: `AI: ผม${LENGTHS.find(l => l.code === len).th} (${len}) · ${thickness} · ${q.svcs.map(s => s.th).join(' + ')} · ${String(x.reason || '').slice(0, 160)}`,
    },
  };
}

/**
 * AI อ่านสลิป แล้วโค้ดตรวจ: ยอด ≥ มัดจำ · เวลาโอนตรงกับช่วงที่จอง · เลขอ้างอิงไม่ซ้ำนัดอื่น · บัญชีผู้รับตรงกับร้าน
 * ผ่านทุกข้อ → ยืนยันนัดอัตโนมัติ · ไม่ผ่าน/AI ใช้ไม่ได้ → คงสถานะรอตรวจ ให้แอดมินดูเหตุผล
 * ข้อจำกัด: AI อ่านจากภาพเท่านั้น ยืนยันกับธนาคารไม่ได้ (ระบบจริงควรใช้ API ตรวจสลิปของธนาคาร)
 */
function checkSlip_(id, dataUrl) {
  const find = () => rows_().find(x => x.v[K.id] === id);
  const r = find();
  let x;
  try {
    x = gemini_(`อ่านสลิปโอนเงินธนาคารไทยหรือพร้อมเพย์ในรูปนี้ ตอบตาม schema
isSlip = false ถ้าไม่ใช่สลิปโอนเงินที่ทำรายการสำเร็จ
amount = ยอดเงินบาท (ตัวเลข)
date = วันที่โอน แปลงเป็นปีคริสต์ศักราชแบบ YYYY-MM-DD (สลิปไทยมักเป็น พ.ศ. ให้ลบ 543)
time = เวลาโอน HH:mm แบบ 24 ชม.
ref = เลขที่รายการหรือรหัสอ้างอิง
receiverName, receiverAccount = ชื่อและเลขบัญชี/พร้อมเพย์ของผู้รับตามที่เห็น (คง x ที่ปิดไว้)
looksEdited = true ถ้ามีร่องรอยการแก้ไขภาพ เช่น ฟอนต์หรือตัวเลขไม่เข้ากัน
ห้ามเดา ถ้าอ่านไม่ออกให้เป็นสตริงว่างหรือ 0`, [dataUrl], {
      type: 'object', required: ['isSlip', 'amount', 'date', 'time', 'ref', 'receiverName', 'receiverAccount', 'looksEdited'],
      properties: {
        isSlip: { type: 'boolean' }, amount: { type: 'number' }, date: { type: 'string' }, time: { type: 'string' },
        ref: { type: 'string' }, receiverName: { type: 'string' }, receiverAccount: { type: 'string' }, looksEdited: { type: 'boolean' },
      },
    });
  } catch (err) {
    if (err.message === 'AI_OFF') return { booking: toBooking_(r.v), aiSlip: null };
    setCells_(r.row, { [K.aiSlip]: `– AI ตรวจไม่ได้: ${err.message}`.slice(0, 300) });
    return { booking: toBooking_(r.v), aiSlip: { verdict: 'skip', reasons: ['AI ตรวจไม่ได้ตอนนี้ ร้านจะตรวจเอง'] } };
  }

  const reasons = [];
  const ref = String(x.ref || '').replace(/\s/g, '');
  if (!x.isSlip) reasons.push('รูปนี้ไม่ใช่สลิปโอนเงิน');
  else {
    if (!(Number(x.amount) >= SHOP.deposit)) reasons.push(`ยอดโอน ฿${Number(x.amount) || 0} ไม่ถึงมัดจำ ฿${SHOP.deposit}`);
    let date = String(x.date || '');
    if (/^\d{4}-/.test(date) && Number(date.slice(0, 4)) > 2400) date = (Number(date.slice(0, 4)) - 543) + date.slice(4);
    const paid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:\d{2}$/.test(x.time) ? tsMs_(`${date} ${x.time.padStart(5, '0')}`) : NaN;
    if (isNaN(paid)) reasons.push('อ่านวันเวลาโอนไม่ออก');
    else if (paid < tsMs_(r.v[K.created]) - 60 * 60000 || paid > Date.now() + 10 * 60000) reasons.push('เวลาโอนไม่ตรงกับช่วงที่จอง');
    if (!ref) reasons.push('อ่านเลขอ้างอิงไม่ออก');
    else if (rows_().some(o => o.v[K.slipRef] === ref && o.v[K.id] !== id)) reasons.push('สลิปนี้เคยใช้กับนัดอื่นแล้ว (เลขอ้างอิงซ้ำ)');
    const pp = String(PropertiesService.getScriptProperties().getProperty('PROMPTPAY_ID') || '').replace(/\D/g, '');
    const seen = String(x.receiverAccount || '').match(/\d{3,}/g) || [];
    if (pp && !seen.some(g => pp.includes(g))) reasons.push('บัญชีผู้รับไม่ตรงกับบัญชีร้าน');
    if (x.looksEdited) reasons.push('AI สงสัยว่าภาพสลิปถูกแก้ไข');
  }
  const pass = !reasons.length;
  setCells_(r.row, pass
    ? { [K.aiSlip]: `✓ ผ่าน · ฿${x.amount} · ${x.date} ${x.time} · ${x.receiverName || ''}`.slice(0, 300), [K.slipRef]: ref }
    : { [K.aiSlip]: `✗ ${reasons.join(' / ')}`.slice(0, 300) });
  const auto = PropertiesService.getScriptProperties().getProperty('AI_AUTO_CONFIRM') !== 'off';
  if (pass && auto && r.v[K.status] === STATUS.PENDING) return { booking: confirm_(r), aiSlip: { verdict: 'pass', reasons: [] } };
  return { booking: toBooking_(find().v), aiSlip: { verdict: pass ? 'pass' : 'fail', reasons } };
}

/** รับมัดจำแล้ว → ยืนยันนัด + ส่ง Flex ยืนยัน */
function confirm_(r) {
  setCells_(r.row, { [K.status]: STATUS.CONFIRMED, [K.depositStatus]: DEPOSIT.PAID, [K.confirmedAt]: nowStr_() });
  const rec = toBooking_(rows_().find(x => x.row === r.row).v);
  if (r.v[K.uid]) push_(r.v[K.uid], [confirmFlex_(rec)]);
  return rec;
}

// ---------- team tasks ----------

function seedTasks_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TASKS_SHEET);
  if (sh.getLastRow() > 1) return;
  const rows = DEFAULT_TASKS.map(([p, owner, title, due], i) => ['T' + String(i + 1).padStart(2, '0'), PHASES[p], owner, title, due, '', '', '']);
  sh.getRange(2, 1, rows.length, TASK_HEADERS.length).setNumberFormat('@').setValues(rows);
}

function tasks_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TASKS_SHEET);
  if (!sh) throw new Error('ยังไม่มีแท็บ Tasks กรุณา Run setup ใน Apps Script');
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, TASK_HEADERS.length).getDisplayValues()
    .map(v => ({ id: v[0], phase: v[1], owner: v[2], title: v[3], due: v[4], done: v[5] === 'yes', by: v[6], at: v[7] }));
}

function taskRow_(id) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TASKS_SHEET);
  const ids = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]);
  const i = ids.indexOf(String(id));
  if (i < 0) throw new Error('ไม่พบงานนี้');
  return { row: i + 2 };
}

// ---------- LINE messages ----------

function fill_(tpl, b) {
  const map = { 'ชื่อ': b.name, 'วันที่': thaiDate_(b.date), 'เวลา': b.start, 'ช่าง': b.stylist,
    'บริการ': b.services, 'รหัสจอง': b.id, 'ลิงก์จอง': LIFF_URL,
    'ช่วงเวลา': b.window ? `\nระบบจัดเวลาให้ใน${(SHOP.windows.find(w => w.id === b.window) || {}).th}ที่เลือก ให้ช่างว่างพอดีไม่ต้องรอ` : '' };
  return tpl.replace(/\{(ชื่อ|วันที่|เวลา|ช่าง|บริการ|รหัสจอง|ลิงก์จอง|ช่วงเวลา)\}/g, (_, k) => map[k] || '');
}

/** ข้อความสั้นแบบการ์ด: ข้อความตามเทมเพลต + ปุ่มลิงก์ (altText = ข้อความเดียวกัน) */
function card_(tpl, b, buttons) {
  const text = fill_(tpl, b);
  return {
    type: 'flex', altText: text.slice(0, 400),
    contents: {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: [
        { type: 'text', text, wrap: true, size: 'sm', color: '#1B2533' }] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons.map(([label, uri], i) => ({
        type: 'button', height: 'sm', style: i === 0 ? 'primary' : 'secondary', color: i === 0 ? '#5A7FA8' : undefined,
        action: { type: 'uri', label, uri } })) },
    },
  };
}

/** Flex ยืนยันการจอง (altText = ข้อความยืนยันตามเทมเพลต) */
function confirmFlex_(b) {
  const row = (k, v) => ({
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: k, size: 'sm', color: '#6B7686', flex: 2 },
      { type: 'text', text: v || '-', size: 'sm', color: '#1B2533', flex: 5, wrap: true },
    ],
  });
  return {
    type: 'flex', altText: fill_(MSG.confirmed, b).slice(0, 400),
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1E2B3C', paddingAll: '18px', spacing: 'sm', contents: [
          { type: 'image', url: SITE + 'assets/logo-dark.png', size: 'full', aspectRatio: '4:1', aspectMode: 'fit' },
          { type: 'text', text: '✓ BOOKING CONFIRMED', color: '#9DB7D5', size: 'xs', align: 'center', weight: 'bold' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '20px', contents: [
          { type: 'text', text: thaiDate_(b.date), size: 'xxl', weight: 'bold', color: '#1B2533' },
          { type: 'text', text: `${b.start} – ${b.end} น.`, size: 'lg', weight: 'bold', color: '#5A7FA8' },
          { type: 'separator', margin: 'lg' },
          { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: [
            row('ช่าง', b.stylist), row('บริการ', b.services), row('มัดจำ', `฿${b.deposit} · ${b.depositStatus}`), row('รหัส', b.id)] },
          { type: 'text', text: 'เลื่อนนัดได้ฟรีก่อน 24 ชม. ผ่านเมนู MY BOOKING', size: 'xs', color: '#6B7686', wrap: true, margin: 'lg' },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#5A7FA8', height: 'sm', action: { type: 'uri', label: 'ดูนัด', uri: LIFF_URL + '?page=my' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: 'แผนที่', uri: SHOP.mapUrl } },
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
  sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setNumberFormat('@').setValues([v]);
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
    visit: Number(v[K.visit]) || 0, channel: v[K.channel], rating: Number(v[K.rating]) || 0, window: v[K.window],
  };
  if (admin) {
    Object.assign(b, {
      created: v[K.created], phone: v[K.phone], pronoun: v[K.pronoun], chem: v[K.chem], note: v[K.note],
      photos: v[K.photos] ? v[K.photos].split(' ') : [], slip: v[K.slip], arrived: v[K.arrived],
      started: v[K.started], finished: v[K.finished], cancelled: v[K.cancelled], confirmedAt: v[K.confirmedAt],
      review: v[K.review], aiEstimate: v[K.aiEstimate], aiSlip: v[K.aiSlip],
    });
  }
  return b;
}

function thaiDate_(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
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
    console.error('push failed', err); // งานหลักสำเร็จแล้ว ไม่ให้ error ของ push ทำให้ล้ม
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
