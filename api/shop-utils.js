/* ─── Kay's Works — Shared Utilities ─── */
/* Loaded by both shop.html and shop-admin.html */
/* DO NOT put DOM-specific or page-specific code here */

let SHOP_RATE = 1400; // default — overridden by shop_config.ngn_per_usd or live fetch
const FLW_PUBLIC_KEY = 'FLWPUBK-e4b3851eb2d1a65a71d4c683e6d4c627-X';

// ── Visitor currency detection & toggle ──────────────────────────────────────
let _visitorCurrency = null;  // detected currency code e.g. 'GBP'
let _visitorSymbol   = null;  // e.g. '£'
let _visitorRate     = null;  // units of visitor currency per 1 NGN
let _visitorFlag     = '🇳🇬';
let _visitorLabel    = '';
let _showLocalCurrency = false;
let _activeCurrency  = 'NGN'; // currently displayed currency

const CURRENCY_SYMBOLS = {
  USD:'$', EUR:'€', GBP:'£', CAD:'CA$', AUD:'A$', JPY:'¥', CNY:'¥',
  INR:'₹', BRL:'R$', MXN:'MX$', ZAR:'R', GHS:'₵', KES:'KSh',
  EGP:'E£', MAD:'MAD', TZS:'TSh', UGX:'USh', XOF:'CFA', XAF:'CFA',
  SGD:'S$', HKD:'HK$', NZD:'NZ$', CHF:'CHF', SEK:'kr', NOK:'kr',
  DKK:'kr', AED:'AED', SAR:'SAR', QAR:'QAR', KWD:'KD', PKR:'₨',
  BDT:'৳', LKR:'Rs', THB:'฿', IDR:'Rp', MYR:'RM', PHP:'₱',
  VND:'₫', KRW:'₩', TWD:'NT$', TRY:'₺', PLN:'zł', CZK:'Kč',
  HUF:'Ft', RON:'lei', HRK:'kn', RUB:'₽', UAH:'₴', ILS:'₪',
  CLP:'CL$', COP:'CO$', PEN:'S/', ARS:'AR$', UYU:'$U',
};

const CURRENCY_FLAGS = {
  USD:'🇺🇸', EUR:'🇪🇺', GBP:'🇬🇧', CAD:'🇨🇦', AUD:'🇦🇺', JPY:'🇯🇵',
  GHS:'🇬🇭', KES:'🇰🇪', ZAR:'🇿🇦', EGP:'🇪🇬', SGD:'🇸🇬', AED:'🇦🇪',
  INR:'🇮🇳', BRL:'🇧🇷', MXN:'🇲🇽', CNY:'🇨🇳', CHF:'🇨🇭', SEK:'🇸🇪',
  NOK:'🇳🇴', DKK:'🇩🇰', NZD:'🇳🇿', HKD:'🇭🇰', TWD:'🇹🇼', KRW:'🇰🇷',
  TRY:'🇹🇷', PLN:'🇵🇱', SAR:'🇸🇦', QAR:'🇶🇦', MAD:'🇲🇦',
};

const CURRENCY_NAMES = {
  USD:'US Dollar', EUR:'Euro', GBP:'British Pound', CAD:'Canadian Dollar',
  AUD:'Australian Dollar', JPY:'Japanese Yen', GHS:'Ghanaian Cedi',
  KES:'Kenyan Shilling', ZAR:'South African Rand', AED:'UAE Dirham',
  INR:'Indian Rupee', SGD:'Singapore Dollar', CHF:'Swiss Franc',
  NOK:'Norwegian Krone', SEK:'Swedish Krona', DKK:'Danish Krone',
  NZD:'New Zealand Dollar', MXN:'Mexican Peso', BRL:'Brazilian Real',
};

// All supported currencies for the dropdown
const ALL_CURRENCIES = [
  { code:'NGN', flag:'🇳🇬', name:'Nigerian Naira' },
  { code:'USD', flag:'🇺🇸', name:'US Dollar' },
  { code:'GBP', flag:'🇬🇧', name:'British Pound' },
  { code:'EUR', flag:'🇪🇺', name:'Euro' },
  { code:'CAD', flag:'🇨🇦', name:'Canadian Dollar' },
  { code:'AUD', flag:'🇦🇺', name:'Australian Dollar' },
  { code:'GHS', flag:'🇬🇭', name:'Ghanaian Cedi' },
  { code:'KES', flag:'🇰🇪', name:'Kenyan Shilling' },
  { code:'ZAR', flag:'🇿🇦', name:'South African Rand' },
  { code:'AED', flag:'🇦🇪', name:'UAE Dirham' },
  { code:'INR', flag:'🇮🇳', name:'Indian Rupee' },
  { code:'SGD', flag:'🇸🇬', name:'Singapore Dollar' },
  { code:'JPY', flag:'🇯🇵', name:'Japanese Yen' },
  { code:'CHF', flag:'🇨🇭', name:'Swiss Franc' },
  { code:'NOK', flag:'🇳🇴', name:'Norwegian Krone' },
  { code:'NZD', flag:'🇳🇿', name:'New Zealand Dollar' },
];

let _allRates = {}; // NGN-based rates for all currencies

// Full world country-currency list — compact tuples [country, flag, code, symbol, name]
// Loaded lazily (only parsed when modal opens), rendered virtually (only visible rows in DOM)
const _LCD=[
['Nigeria','ng','NGN','₦','Nigerian Naira'],
['Afghanistan','af','AFN','؋','Afghan Afghani'],
['Albania','al','ALL','L','Albanian Lek'],
['Algeria','dz','DZD','دج','Algerian Dinar'],
['Angola','ao','AOA','Kz','Angolan Kwanza'],
['Argentina','ar','ARS','$','Argentine Peso'],
['Armenia','am','AMD','֏','Armenian Dram'],
['Australia','au','AUD','A$','Australian Dollar'],
['Austria','at','EUR','€','Euro'],
['Azerbaijan','az','AZN','₼','Azerbaijani Manat'],
['Bahrain','bh','BHD','.د.ب','Bahraini Dinar'],
['Bangladesh','bd','BDT','৳','Bangladeshi Taka'],
['Belarus','by','BYN','Br','Belarusian Ruble'],
['Belgium','be','EUR','€','Euro'],
['Belize','bz','BZD','BZ$','Belize Dollar'],
['Bolivia','bo','BOB','Bs','Bolivian Boliviano'],
['Bosnia','ba','BAM','KM','Bosnia Mark'],
['Botswana','bw','BWP','P','Botswana Pula'],
['Brazil','br','BRL','R$','Brazilian Real'],
['Brunei','bn','BND','B$','Brunei Dollar'],
['Bulgaria','bg','BGN','лв','Bulgarian Lev'],
['Cambodia','kh','KHR','₭','Cambodian Riel'],
['Cameroon','cm','XAF','CFA','CFA Franc'],
['Canada','ca','CAD','CA$','Canadian Dollar'],
['Chile','cl','CLP','CL$','Chilean Peso'],
['China','cn','CNY','¥','Chinese Yuan'],
['Colombia','co','COP','CO$','Colombian Peso'],
['Costa Rica','cr','CRC','₡','Costa Rican Colón'],
['Croatia','hr','EUR','€','Euro'],
['Cuba','cu','CUP','$','Cuban Peso'],
['Czech Republic','cz','CZK','Kč','Czech Koruna'],
['Denmark','dk','DKK','kr','Danish Krone'],
['Dominican Republic','do','DOP','RD$','Dominican Peso'],
['Ecuador','ec','USD','$','US Dollar'],
['Egypt','eg','EGP','E£','Egyptian Pound'],
['El Salvador','sv','USD','$','US Dollar'],
['Estonia','ee','EUR','€','Euro'],
['Ethiopia','et','ETB','Br','Ethiopian Birr'],
['European Union','eu','EUR','€','Euro'],
['Finland','fi','EUR','€','Euro'],
['France','fr','EUR','€','Euro'],
['Georgia','ge','GEL','₾','Georgian Lari'],
['Germany','de','EUR','€','Euro'],
['Ghana','gh','GHS','₵','Ghanaian Cedi'],
['Greece','gr','EUR','€','Euro'],
['Guatemala','gt','GTQ','Q','Guatemalan Quetzal'],
['Honduras','hn','HNL','L','Honduran Lempira'],
['Hong Kong','hk','HKD','HK$','Hong Kong Dollar'],
['Hungary','hu','HUF','Ft','Hungarian Forint'],
['Iceland','is','ISK','kr','Icelandic Króna'],
['India','in','INR','₹','Indian Rupee'],
['Indonesia','id','IDR','Rp','Indonesian Rupiah'],
['Iran','ir','IRR','﷼','Iranian Rial'],
['Iraq','iq','IQD','ع.د','Iraqi Dinar'],
['Ireland','ie','EUR','€','Euro'],
['Israel','il','ILS','₪','Israeli Shekel'],
['Italy','it','EUR','€','Euro'],
['Ivory Coast','ci','XOF','CFA','CFA Franc'],
['Jamaica','jm','JMD','J$','Jamaican Dollar'],
['Japan','jp','JPY','¥','Japanese Yen'],
['Jordan','jo','JOD','JD','Jordanian Dinar'],
['Kazakhstan','kz','KZT','₸','Kazakhstani Tenge'],
['Kenya','ke','KES','KSh','Kenyan Shilling'],
['Kuwait','kw','KWD','KD','Kuwaiti Dinar'],
['Kyrgyzstan','kg','KGS','лв','Kyrgyzstani Som'],
['Latvia','lv','EUR','€','Euro'],
['Lebanon','lb','LBP','ل.ل','Lebanese Pound'],
['Libya','ly','LYD','ل.د','Libyan Dinar'],
['Lithuania','lt','EUR','€','Euro'],
['Luxembourg','lu','EUR','€','Euro'],
['Malaysia','my','MYR','RM','Malaysian Ringgit'],
['Maldives','mv','MVR','Rf','Maldivian Rufiyaa'],
['Malta','mt','EUR','€','Euro'],
['Mexico','mx','MXN','MX$','Mexican Peso'],
['Moldova','md','MDL','L','Moldovan Leu'],
['Morocco','ma','MAD','MAD','Moroccan Dirham'],
['Mozambique','mz','MZN','MT','Mozambican Metical'],
['Myanmar','mm','MMK','K','Myanmar Kyat'],
['Namibia','na','NAD','N$','Namibian Dollar'],
['Nepal','np','NPR','₨','Nepalese Rupee'],
['Netherlands','nl','EUR','€','Euro'],
['New Zealand','nz','NZD','NZ$','New Zealand Dollar'],
['Nicaragua','ni','NIO','C$','Nicaraguan Córdoba'],
['North Macedonia','mk','MKD','ден','Macedonian Denar'],
['Norway','no','NOK','kr','Norwegian Krone'],
['Oman','om','OMR','﷼','Omani Rial'],
['Pakistan','pk','PKR','₨','Pakistani Rupee'],
['Panama','pa','PAB','B/.','Panamanian Balboa'],
['Paraguay','py','PYG','₲','Paraguayan Guaraní'],
['Peru','pe','PEN','S/','Peruvian Sol'],
['Philippines','ph','PHP','₱','Philippine Peso'],
['Poland','pl','PLN','zł','Polish Zloty'],
['Portugal','pt','EUR','€','Euro'],
['Qatar','qa','QAR','﷼','Qatari Riyal'],
['Romania','ro','RON','lei','Romanian Leu'],
['Russia','ru','RUB','₽','Russian Ruble'],
['Rwanda','rw','RWF','RF','Rwandan Franc'],
['Saudi Arabia','sa','SAR','﷼','Saudi Riyal'],
['Senegal','sn','XOF','CFA','CFA Franc'],
['Serbia','rs','RSD','дин','Serbian Dinar'],
['Singapore','sg','SGD','S$','Singapore Dollar'],
['Somalia','so','SOS','Sh','Somali Shilling'],
['South Africa','za','ZAR','R','South African Rand'],
['South Korea','kr','KRW','₩','South Korean Won'],
['Spain','es','EUR','€','Euro'],
['Sri Lanka','lk','LKR','Rs','Sri Lankan Rupee'],
['Sudan','sd','SDG','ج.س','Sudanese Pound'],
['Sweden','se','SEK','kr','Swedish Krona'],
['Switzerland','ch','CHF','CHF','Swiss Franc'],
['Taiwan','tw','TWD','NT$','Taiwan Dollar'],
['Tanzania','tz','TZS','TSh','Tanzanian Shilling'],
['Thailand','th','THB','฿','Thai Baht'],
['Trinidad & Tobago','tt','TTD','TT$','Trinidad Dollar'],
['Tunisia','tn','TND','د.ت','Tunisian Dinar'],
['Turkey','tr','TRY','₺','Turkish Lira'],
['Uganda','ug','UGX','USh','Ugandan Shilling'],
['Ukraine','ua','UAH','₴','Ukrainian Hryvnia'],
['United Arab Emirates','ae','AED','د.إ','UAE Dirham'],
['United Kingdom','gb','GBP','£','British Pound'],
['United States','us','USD','$','US Dollar'],
['Uruguay','uy','UYU','$U','Uruguayan Peso'],
['Uzbekistan','uz','UZS','лв','Uzbekistani Som'],
['Venezuela','ve','VES','Bs.S','Venezuelan Bolívar'],
['Vietnam','vn','VND','₫','Vietnamese Dong'],
['Zambia','zm','ZMW','ZK','Zambian Kwacha'],
['Zimbabwe','zw','ZWL','Z$','Zimbabwean Dollar'],
];
// Lazy-parsed full list — only converted to objects when modal opens
let _localeCountries = null;
function getLocaleCountries() {
  if (!_localeCountries) {
    _localeCountries = _LCD.map(r => ({country:r[0],flag:r[1],code:r[2],symbol:r[3],name:r[4]}));
  }
  return _localeCountries;
}
const ALL_LOCALE_COUNTRIES = {find: fn => getLocaleCountries().find(fn)}; // compat shim

let _localeFilter = '';

function buildCurrencyDropdown(detectedCode) {
  // Keep ALL_CURRENCIES list in sync (used by old toggle path)
  renderLocaleList(detectedCode || 'NGN');
}

function renderLocaleList(activeCurrency) {
  const list = document.getElementById('localeList');
  if (!list) return;
  const q = _localeFilter.toLowerCase();
  const filtered = getLocaleCountries().filter(c =>
    !q || c.country.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
  // Virtual render — cap at 80 visible items for performance, search narrows it
  const visible = filtered.slice(0, 80);
  list.innerHTML = visible.map(c => {
    const flagImg = c.flag && c.flag.length === 2
      ? `<img src="https://flagcdn.com/16x12/${c.flag}.png" width="16" height="12" alt="${c.country}" style="border-radius:2px;vertical-align:middle"/>`
      : `<span>${c.flag||'🌍'}</span>`;
    return `<div class="locale-item${c.code === (activeCurrency || _activeCurrency) ? ' active' : ''}" onclick="setCurrency('${c.code}');closeLocaleModal()">
      <div class="locale-item-left">
        <span class="locale-item-flag">${flagImg}</span>
        <span>${c.country}</span>
      </div>
      <div class="locale-item-right">${c.code} ${c.symbol}</div>
    </div>`;
  }).join('');
}

function openLocaleModal() {
  _localeFilter = '';
  const search = document.getElementById('localeSearch');
  if (search) search.value = '';
  renderLocaleList(_activeCurrency);
  // Update current label
  const curr = getLocaleCountries().find(c => c.code === _activeCurrency) || getLocaleCountries()[0];
  const el = document.getElementById('localeCurrent');
  const modalFlagHtml = curr.flag && curr.flag.length === 2
    ? `<img src="https://flagcdn.com/20x15/${curr.flag}.png" width="20" height="15" style="border-radius:2px;vertical-align:middle;margin-right:4px" alt=""/>`
    : curr.flag || '';
  if (el) el.innerHTML = `${modalFlagHtml} ${curr.country} | ${curr.code} ${curr.symbol}<br><span>You are currently viewing prices in ${curr.code} ${curr.symbol}.</span>`;
  document.getElementById('localeModalOverlay').style.display = '';
  document.getElementById('localeModal').style.display = '';
  document.body.style.overflow = 'hidden';
  if (search) setTimeout(() => search.focus(), 100);
}

function closeLocaleModal() {
  document.getElementById('localeModalOverlay').style.display = 'none';
  document.getElementById('localeModal').style.display = 'none';
  document.body.style.overflow = '';
}

function filterLocale(q) {
  _localeFilter = q;
  renderLocaleList(_activeCurrency);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLocaleModal();
});

async function detectVisitorCurrency() {
  try {
    // Fetch all rates in one call
    const rateRes = await fetch('https://open.er-api.com/v6/latest/NGN', { signal: AbortSignal.timeout(5000) });
    const rateData = await rateRes.json();
    if (rateData?.rates) _allRates = rateData.rates;

    // Detect visitor location
    const forceCurrency = new URLSearchParams(location.search).get('currency');
    const geo = forceCurrency
      ? { currency: forceCurrency }
      : await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) }).then(r => r.json());
    const detected = geo.currency || 'NGN';

    // Build full dropdown for everyone
    buildCurrencyDropdown(detected);

    // Auto-apply detected currency
    setCurrency(detected);
  } catch(e) {
    // On failure still build dropdown with NGN selected
    buildCurrencyDropdown('NGN');
  }
}

function initCurrencySelector() {
  // Fallback if detectVisitorCurrency hasn't built dropdown yet
  if (document.querySelector('#currencyDropdown .currency-option')) return;
  buildCurrencyDropdown('NGN');
}



function setCurrency(code) {
  // Close dropdowns
  ['currencyDropdown','currencyDropdownMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const curr = getLocaleCountries().find(c => c.code === code) || getLocaleCountries()[0];

  if (code === 'NGN') {
    _showLocalCurrency = false;
    _activeCurrency = 'NGN';
    _visitorRate = null;
    _visitorSymbol = null;
  } else {
    const rate = _allRates[code];
    if (!rate) return;
    _showLocalCurrency = true;
    _activeCurrency = code;
    _visitorCurrency = code;
    _visitorSymbol   = CURRENCY_SYMBOLS[code] || code + ' ';
    _visitorFlag     = curr.flag;
    _visitorLabel    = curr.name;
    _visitorRate     = rate;
  }

  // Update selector button
  const flagHtml = curr.flag && curr.flag.length === 2
    ? `<img src="https://flagcdn.com/16x12/${curr.flag}.png" width="16" height="12" style="border-radius:2px;vertical-align:middle" alt="${curr.country}"/>`
    : curr.flag || '';
  [['currencyFlag','currencyCode'],['currencyFlagMobile','currencyCodeMobile'],['currencyFlagBar','currencyCodeBar']].forEach(([fId,cId]) => {
    const fEl = document.getElementById(fId);
    const cEl = document.getElementById(cId);
    if (fEl) fEl.innerHTML = flagHtml;
    if (cEl) cEl.textContent = code;
  });

  // Mark active in dropdown
  ['currencyDropdown','currencyDropdownMobile'].forEach(id => {
    const dd = document.getElementById(id);
    if (!dd) return;
    dd.querySelectorAll('.currency-option').forEach(el => {
      el.classList.toggle('active', el.textContent.includes(code));
    });
  });

  // Save to sessionStorage so print-detail page can read the preference
  try {
    sessionStorage.setItem('kw_currency', code);
    sessionStorage.setItem('kw_rate', _visitorRate ? String(_visitorRate) : '');
    sessionStorage.setItem('kw_symbol', _visitorSymbol || '');
  } catch(e) {}
  refreshAllPrices();
  renderCheckoutSummary();
}

function fmtLocal(ngn) {
  if (!_visitorRate || !_visitorSymbol) return '';
  const amount = ngn * _visitorRate;
  const formatted = amount >= 100
    ? Math.round(amount).toLocaleString()
    : amount >= 1 ? amount.toFixed(2) : amount.toFixed(3);
  return _visitorSymbol + formatted;
}

function toggleCurrency() { setCurrency(_showLocalCurrency ? 'NGN' : 'local'); }

function refreshAllPrices() {
  if (typeof SHOP_CONFIG === 'undefined') return;
  (SHOP_CONFIG.products || []).forEach(p => {
    const ngnEl   = document.getElementById('pngn-' + p.id);
    const localEl = document.getElementById('plocal-' + p.id);
    if (!ngnEl) return;
    // Get the base NGN price for this product
    const allNgn = Object.values(p.priceNgn || p.prices_ngn || {}).map(Number).filter(Boolean);
    const baseNgn = allNgn.length ? Math.min(...allNgn) : 0;
    if (!baseNgn) return;
    if (_showLocalCurrency && _visitorRate) {
      ngnEl.style.display = 'none';
      const prefix = allNgn.length > 1 ? 'from ' : '';
      if (localEl) { localEl.textContent = prefix + fmtLocal(baseNgn); localEl.style.display = ''; }
    } else {
      ngnEl.style.display = '';
      if (localEl) localEl.style.display = 'none';
    }
  });
}

document.addEventListener('click', e => {
  if (e.target.id === 'currencyToggle' || e.target.id === 'currencyToggleMobile') toggleCurrency();
});

let SHOP_CONFIG = {
  // Wallet addresses are the single source of truth on the server (shop_config,
  // the same row the server verifies incoming payments against). They are loaded
  // at runtime in loadShopData(); never hardcode them here, so the displayed
  // address can never drift from the one the server checks.
  ethAddress:         '',
  tezosAddress:       '',
  featured_product_id: '', // set in admin — ID of the featured print this month
  discount_codes:     [],  // managed in admin → Discounts tab
  products: [
    // One print product is one artwork. The print formats and sizes live inside variants.
    {
      id: 'print-sample-artwork', category: 'prints', name: 'Sample Artwork',
      desc: 'Choose the print format and size for this artwork.',
      emoji: '🖼',
      variants: [
        {
          type: 'Mini Print',
          desc: 'Small-format giclée on cotton rag. Perfect for collectors and gifting. Half-inch border minimum. Ships flat.',
          sizes: ['4×4"', '4×6"', '5×5"'],
        },
        {
          type: 'Photographic Print',
          desc: 'Luster finish on photo-grade paper with pigment inks. Rich detail, subtle sheen, no glare. Listed by sheet size, min 1-inch border.',
          sizes: ['5×7"', '8×10"', '11×14"', '18×24"'],
        },
        {
          type: 'Giclée Art Print',
          desc: 'Gallery-quality giclée on 100% cotton rag archival paper (300gsm). 10-colour pigment ink. Min 1-inch white border. Signed.',
          sizes: ['4×4"', '5×7"', '8×10"', '11×14"', '18×24"'],
        },
      ],
      availableVariants: {
        'Mini Print': ['4×4"', '4×6"', '5×5"'],
        'Photographic Print': ['5×7"', '8×10"', '11×14"', '18×24"'],
        'Giclée Art Print': ['4×4"', '5×7"', '8×10"', '11×14"', '18×24"'],
      },
      priceNgn: {
        'Mini Print|4×4"': 8000, 'Mini Print|4×6"': 9500, 'Mini Print|5×5"': 9000,
        'Photographic Print|5×7"': 13000, 'Photographic Print|8×10"': 20000, 'Photographic Print|11×14"': 32000, 'Photographic Print|18×24"': 62000,
        'Giclée Art Print|4×4"': 12000, 'Giclée Art Print|5×7"': 16000, 'Giclée Art Print|8×10"': 25000, 'Giclée Art Print|11×14"': 40000, 'Giclée Art Print|18×24"': 75000,
      },
      priceUsd: {
        'Mini Print|4×4"': 5, 'Mini Print|4×6"': 6, 'Mini Print|5×5"': 6,
        'Photographic Print|5×7"': 9, 'Photographic Print|8×10"': 14, 'Photographic Print|11×14"': 22, 'Photographic Print|18×24"': 44,
        'Giclée Art Print|4×4"': 8, 'Giclée Art Print|5×7"': 11, 'Giclée Art Print|8×10"': 18, 'Giclée Art Print|11×14"': 28, 'Giclée Art Print|18×24"': 52,
      },
      badge: '', image: '',
    },
    {
      id: 'tee-001', category: 'merch', name: 'Àpótí T-Shirt',
      desc: '100% heavyweight cotton. Screen-printed design. Pre-shrunk. Unisex relaxed fit.',
      emoji: '👕',
      clothing: true, clothing_type: 'tee',
      variants: ['S', 'M', 'L', 'XL', 'XXL'],
      priceNgn: { S: 22000, M: 22000, L: 22000, XL: 24000, XXL: 24000 },
      priceUsd: { S: 15, M: 15, L: 15, XL: 16, XXL: 16 },
      badge: 'New', image: '',
    },
    {
      id: 'hoodie-001', category: 'merch', name: 'Àpótí Hoodie',
      desc: '380gsm heavyweight fleece. Drop-shoulder, oversized silhouette. Screen-printed. Kangaroo pocket.',
      emoji: '🧥',
      clothing: true, clothing_type: 'hoodie',
      variants: ['S', 'M', 'L', 'XL', 'XXL'],
      priceNgn: { S: 42000, M: 42000, L: 42000, XL: 45000, XXL: 45000 },
      priceUsd: { S: 28, M: 28, L: 28, XL: 30, XXL: 30 },
      badge: '', image: '',
    },
    {
      id: 'tote-001', category: 'merch', name: 'Canvas Tote Bag',
      desc: 'Heavy-duty natural canvas. Screen-printed. Holds everything.',
      emoji: '🛍',
      variants: ['One size'],
      priceNgn: { 'One size': 14000 },
      priceUsd: { 'One size': 9 },
      badge: '', image: '',
    },
    {
      id: 'nb-001', category: 'notebooks', name: 'Faux Leather Journal — Classic',
      desc: 'A5 faux leather bound notebook. 200 ivory pages, lay-flat binding.',
      emoji: '📓',
      variants: ['Midnight', 'Cognac', 'Olive'],
      priceNgn: { Midnight: 19000, Cognac: 19000, Olive: 19000 },
      priceUsd: { Midnight: 13, Cognac: 13, Olive: 13 },
      badge: 'Bestseller', image: '',
    },
    {
      id: 'nb-002', category: 'notebooks', name: 'Faux Leather Journal — Large',
      desc: 'A4 faux leather bound notebook. 240 ivory pages, ribbon marker.',
      emoji: '📒',
      variants: ['Midnight', 'Cognac'],
      priceNgn: { Midnight: 24000, Cognac: 24000 },
      priceUsd: { Midnight: 16, Cognac: 16 },
      badge: '', image: '',
    },
    {
      id: 'stk-001', category: 'stickers', name: 'Àpótí Sticker Pack',
      desc: 'Set of 6 die-cut vinyl stickers. Waterproof. Dishwasher-safe.',
      emoji: '✦',
      variants: ['Pack of 6'],
      priceNgn: { 'Pack of 6': 4500 },
      priceUsd: { 'Pack of 6': 3 },
      badge: '', image: '',
    },
  ],
};

const SHOP_DEFAULT_PRODUCTS = SHOP_CONFIG.products.map(p => JSON.parse(JSON.stringify(p)));

// Cart state (let, selectedVariants, selectedTypes) lives in shop.html only.

/* ─── Helpers ─── */
function fmt(n) { return '₦' + Number(n).toLocaleString('en-NG'); }
function fmtUsd(n) { return '$' + Number(n).toFixed(0); }
function uid() { return Math.random().toString(36).slice(2,9); }
function showToast(msg, dur=2800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), dur);
}

// Payment processing banner — used by both Paystack redirect and crypto confirm.
function showPaymentBanner(text) {
  const banner = document.getElementById('paymentLoadingBanner');
  const bar = document.getElementById('paymentLoadingBar');
  const bannerText = document.getElementById('paymentLoadingText');
  if (!banner) return;
  if (bannerText) bannerText.textContent = text || 'Confirming your payment… please wait';
  if (bar) bar.style.width = '0%';
  banner.style.display = '';
  let progress = 0;
  if (banner._tick) clearInterval(banner._tick);
  banner._tick = setInterval(() => {
    progress = Math.min(progress + 2, 80);
    if (bar) bar.style.width = progress + '%';
  }, 200);
}
function hidePaymentBanner(success) {
  const banner = document.getElementById('paymentLoadingBanner');
  const bar = document.getElementById('paymentLoadingBar');
  const bannerText = document.getElementById('paymentLoadingText');
  if (!banner) return;
  if (banner._tick) clearInterval(banner._tick);
  if (bar) bar.style.width = '100%';
  if (bannerText) bannerText.textContent = success ? 'Payment confirmed ✓' : 'Payment received — see details below';
  setTimeout(() => { banner.style.display = 'none'; }, success ? 1500 : 3000);
}

function printOptionKey(type, size) { return `${type}|${size}`; }
function labelPrintOption(type, size) { return `${type} · ${size}`; }
function keySize(key) { return String(key || '').includes('|') ? String(key).split('|').pop() : String(key || ''); }
function keyType(key) { return String(key || '').includes('|') ? String(key).split('|')[0] : ''; }
// Force bare relative image paths (e.g. "images/x.png") to a site-root path so
// they resolve the same on /shop and /shop/:slug. Leaves absolute, data:, and
// already-rooted URLs untouched. Mirrors normalizeImg in print-detail.html.
function normalizeImg(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:') || s.startsWith('/')) return s;
  return '/' + s.replace(/^\.?\/*/, '');
}
function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function toVariantList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}
function normalizeProduct(p) {
  p.category = p.category || 'merch';
  p.name = p.name || 'Untitled product';
  p.desc = p.desc || p.description || '';
  p.emoji = p.emoji || '✦';
  if (p.category !== 'prints') p.variants = toVariantList(p.variants);
  else p.variants = Array.isArray(p.variants) ? p.variants : [];
  p.priceNgn = p.priceNgn || p.prices_ngn || {};
  p.priceUsd = p.priceUsd || p.prices_usd || {};
  p.badge = p.badge || '';
  p.image = p.image || p.image_url || '';
  p.stock_by_variant = p.stock_by_variant || {};
  p.edition_totals = p.edition_totals || {};
  p.active = p.active !== false;
  return p;
}
function productKey(p) {
  if (!p) return '';
  if (!p._adminKey) p._adminKey = String(p.id || ('prod-' + uid()));
  return p._adminKey;
}
function productByKey(key) {
  return SHOP_CONFIG.products.find(p => productKey(p) === key);
}
function productIndexByKey(key) {
  return SHOP_CONFIG.products.findIndex(p => productKey(p) === key);
}
function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
function makeDuplicateName(name) {
  const base = String(name || 'New product').replace(/\s+\(Copy(?:\s+\d+)?\)$/i, '').trim() || 'New product';
  const existing = new Set(SHOP_CONFIG.products.map(p => String(p.name || '').trim()));
  let next = `${base} (Copy)`;
  let n = 2;
  while (existing.has(next)) next = `${base} (Copy ${n++})`;
  return next;
}
function duplicateProductByKey(key) {
  const source = productByKey(key);
  if (!source) return;
  const copy = normalizeProduct(clonePlain(source));
  copy.id = 'prod-' + uid();
  copy._adminKey = copy.id;
  copy.name = makeDuplicateName(source.name);
  copy.slug = '';
  copy._justAdded = true;
  delete copy._isSample;
  const sameCat = SHOP_CONFIG.products.filter(p => p.category === source.category);
  const minOrder = sameCat.length ? Math.min(...sameCat.map(x => Number(x.sort_order) || 0)) : 0;
  copy.sort_order = minOrder - 1;
  SHOP_CONFIG.products.unshift(copy);
  renderAdminProducts();
  scrollToJustAdded();
}
function removePrintOptionByKey(productKeyValue, type) {
  const p = productByKey(productKeyValue);
  if (!p || p.category !== 'prints' || !type) return;
  const options = getPrintOptions(p);
  const option = options.find(o => o.type === type);
  if (!option) return;

  option.sizes.forEach(size => {
    const key = printOptionKey(type, size);
    if (p.priceNgn) delete p.priceNgn[key];
    if (p.priceUsd) delete p.priceUsd[key];
    if (p.stock_by_variant) delete p.stock_by_variant[key];
    if (p.edition_totals) delete p.edition_totals[key];
  });

  p.variants = options
    .filter(o => o.type !== type)
    .map(o => ({
      type: o.type,
      desc: o.desc || '',
      limited: !!o.limited,
      sizes: [...o.sizes],
      shipping_meta: o.shipping_meta || {},
    }));

  if (p.availableVariants && typeof p.availableVariants === 'object') {
    delete p.availableVariants[type];
  }
  renderAdminProducts();
}
const deletingProductKeys = new Set();
function isApparelProduct(p) {
  const text = `${p.name || ''} ${p.clothing_type || ''} ${p.print_type || ''}`.toLowerCase();
  return p.clothing === true || /\b(tee|t-shirt|tshirt|shirt|hoodie|sweatshirt|cap|hat)\b/.test(text);
}
function apparelTypeFor(p) {
  const text = `${p.name || ''} ${p.clothing_type || ''}`.toLowerCase();
  if (text.includes('hoodie') || text.includes('sweatshirt')) return 'hoodie';
  if (text.includes('cap') || text.includes('hat')) return 'cap';
  if (text.includes('tee') || text.includes('t-shirt') || text.includes('tshirt') || text.includes('shirt')) return 'tee';
  return p.clothing_type || 'tee';
}
function ensureExampleSections() {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  ['prints','merch','notebooks','stickers'].forEach(cat => {
    // A "real" product is one persisted in the DB (UUID id) or freshly added
    // by the user (temp 'prod-…' id) — anything that is not a sample.
    const hasReal = SHOP_CONFIG.products.some(p =>
      (p.category || '') === cat &&
      !p._isSample &&
      (UUID_RE.test(String(p.id || '')) || String(p.id || '').startsWith('prod-'))
    );
    // Drop any leftover samples for this category before re-deciding.
    SHOP_CONFIG.products = SHOP_CONFIG.products.filter(p =>
      !(p._isSample && (p.category || '') === cat));
    if (hasReal) return; // category has real items — show no samples

    const examples = SHOP_DEFAULT_PRODUCTS.filter(p => p.category === cat);
    if (examples.length) {
      examples.forEach(example => {
        const copy = JSON.parse(JSON.stringify(example));
        copy._isSample = true;
        SHOP_CONFIG.products.push(copy);
      });
    } else {
      const copy = defaultProduct(cat);
      copy._isSample = true;
      SHOP_CONFIG.products.push(copy);
    }
  });
}
function defaultProduct(category) {
  const id = 'prod-' + uid();
  if (category === 'notebooks') {
    return normalizeProduct({
      id, category, name: 'Sketch Journal',
      desc: 'Lay-flat notebook for sketches, notes, and studio planning.',
      emoji: '📓', variants: ['A5', 'A4'],
      priceNgn: { A5: 18000, A4: 24000 },
      priceUsd: { A5: 12, A4: 16 },
      badge: '', image: '',
    });
  }
  if (category === 'stickers') {
    return normalizeProduct({
      id, category, name: 'Studio Sticker Pack',
      desc: 'Set of die-cut vinyl stickers for laptops, bottles, and sketchbooks.',
      emoji: '✦', variants: ['Pack of 6'],
      priceNgn: { 'Pack of 6': 4500 },
      priceUsd: { 'Pack of 6': 3 },
      badge: '', image: '',
    });
  }
  return normalizeProduct({
    id, category: 'merch', name: 'New T-Shirt',
    desc: 'Heavyweight cotton merch piece with artwork detail.',
    emoji: '👕', clothing: true, clothing_type: 'tee',
    variants: ['S', 'M', 'L', 'XL'],
    priceNgn: { S: 22000, M: 22000, L: 22000, XL: 24000 },
    priceUsd: { S: 15, M: 15, L: 15, XL: 16 },
    badge: '', image: '',
  });
}

function defaultPrintOptionData() {
  const variants = [
    {
      type: 'Mini Print',
      desc: 'Small-format giclée on cotton rag. Perfect for collectors and gifting. Half-inch border minimum. Ships flat.',
      sizes: ['4×4"', '4×6"', '5×5"'],
    },
    {
      type: 'Photographic Print',
      desc: 'Luster finish on photo-grade paper with pigment inks. Rich detail, subtle sheen, no glare. Listed by sheet size, min 1-inch border.',
      sizes: ['5×7"', '8×10"', '11×14"', '18×24"'],
    },
    {
      type: 'Giclée Art Print',
      desc: 'Gallery-quality giclée on 100% cotton rag archival paper (300gsm). 10-colour pigment ink. Min 1-inch white border. Signed.',
      sizes: ['4×4"', '5×7"', '8×10"', '11×14"', '18×24"'],
    },
  ];
  return {
    variants,
    availableVariants: {
      'Mini Print': ['4×4"', '4×6"', '5×5"'],
      'Photographic Print': ['5×7"', '8×10"', '11×14"', '18×24"'],
      'Giclée Art Print': ['4×4"', '5×7"', '8×10"', '11×14"', '18×24"'],
    },
    priceNgn: {
      'Mini Print|4×4"': 8000, 'Mini Print|4×6"': 9500, 'Mini Print|5×5"': 9000,
      'Photographic Print|5×7"': 13000, 'Photographic Print|8×10"': 20000, 'Photographic Print|11×14"': 32000, 'Photographic Print|18×24"': 62000,
      'Giclée Art Print|4×4"': 12000, 'Giclée Art Print|5×7"': 16000, 'Giclée Art Print|8×10"': 25000, 'Giclée Art Print|11×14"': 40000, 'Giclée Art Print|18×24"': 75000,
    },
    priceUsd: {
      'Mini Print|4×4"': 5, 'Mini Print|4×6"': 6, 'Mini Print|5×5"': 6,
      'Photographic Print|5×7"': 9, 'Photographic Print|8×10"': 14, 'Photographic Print|11×14"': 22, 'Photographic Print|18×24"': 44,
      'Giclée Art Print|4×4"': 8, 'Giclée Art Print|5×7"': 11, 'Giclée Art Print|8×10"': 18, 'Giclée Art Print|11×14"': 28, 'Giclée Art Print|18×24"': 52,
    },
  };
}

function getPrintOptions(p) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const available = p.availableVariants || p.available_variants || [];
  const hasNested = variants.some(v => v && typeof v === 'object' && !Array.isArray(v));

  if (hasNested) {
    return variants.map(v => {
      const type = String(v.type || v.print_type || v.name || v.label || 'Print').trim();
      const sizes = (v.sizes || v.variants || []).map(String).filter(Boolean);
      const availableSizes = (v.available_sizes || v.available || v.available_variants || sizes).map(String).filter(Boolean);
      return { type, desc: v.desc || v.description || '', limited: v.limited === true, sizes, availableSizes: availableSizes.length ? availableSizes : sizes };
    }).filter(o => o.type && o.sizes.length);
  }

  if (available && typeof available === 'object' && !Array.isArray(available)) {
    return Object.entries(available).map(([type, sizes]) => ({
      type,
      desc: '',
      sizes: (Array.isArray(sizes) ? sizes : []).map(String).filter(Boolean),
      availableSizes: (Array.isArray(sizes) ? sizes : []).map(String).filter(Boolean),
    })).filter(o => o.type && o.sizes.length);
  }

  const type = String(p.print_type || p.printType || p.medium || 'Giclee').replace(/\s+print$/i, '').trim() || 'Print';
  const sizes = variants.map(String).filter(Boolean);
  const availableSizes = (Array.isArray(available) && available.length ? available : sizes).map(String).filter(Boolean);
  return sizes.length ? [{ type, desc: p.desc || '', sizes, availableSizes }] : [];
}

function availablePrintChoices(p) {
  return getPrintOptions(p).flatMap(o =>
    (o.availableSizes.length ? o.availableSizes : o.sizes).map(size => ({
      type: o.type,
      size,
      key: printOptionKey(o.type, size),
      label: labelPrintOption(o.type, size),
    }))
  );
}

function availablePrintOptions(p) {
  return getPrintOptions(p).filter(o => (o.availableSizes.length ? o.availableSizes : o.sizes).length);
}

function getActivePrintOption(p) {
  const options = availablePrintOptions(p);
  if (!options.length) return null;
  const selected = selectedTypes[p.id];
  return options.find(o => o.type === selected) || options[0];
}

function optionDisplaySizes(option) {
  if (!option) return [];
  return option.availableSizes.length ? option.availableSizes : option.sizes;
}

function getChoices(p) {
  return (p.variants || []).map(v => ({ key: v, label: v, size: v }));
}

function productPrice(p, key, currency) {
  const prices = currency === 'usd' ? (p.priceUsd || p.prices_usd || {}) : (p.priceNgn || p.prices_ngn || {});
  if (prices[key] !== undefined) return prices[key];
  return prices[keySize(key)] || 0;
}


/* ─── Cart persistence (shared by shop and any page that touches the cart) ─── */
function saveCart() {
  try { localStorage.setItem('kaysworks-cart', JSON.stringify(cart)); } catch (_) {}
}
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem('kaysworks-cart') || '[]');
    cart = Array.isArray(raw) ? raw : [];
  } catch (_) { cart = []; }
}

/* ─── postShopJson — shared HTTP helper ─── */
async function postShopJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} failed`);
  return data;
}
