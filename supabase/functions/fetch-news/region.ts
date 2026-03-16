// supabase/functions/fetch-news/region.ts
export const regionMap:Record<string,string[]> = {
  africa:       ["DZ","AO","BJ","BW","BF","BI","CV","CM","CF","TD","KM","CG","CD","DJ","EG","GQ","ER","SZ","ET","GA","GM","GH","GN","GW","CI","KE","LS","LR","LY","MG","MW","ML","MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD","TG","TN","UG","ZM","ZW","TZ"],
  asia:         ["AF","AM","AZ","BH","BD","BT","BN","KH","CN","CY","GE","IN","ID","IR","IQ","IL","JP","JO","KZ","KP","KR","KW","KG","LA","LB","MY","MV","MN","MM","NP","OM","PK","PS","PH","QA","SA","SG","LK","SY","TJ","TH","TL","TR","TM","AE","UZ","VN","YE"],
  europe:       ["AL","AD","AT","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IE","IT","XK","LV","LI","LT","LU","MT","MD","MC","ME","NL","MK","NO","PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","UA","GB","VA"],
  northamerica: ["AG","BS","BB","BZ","CA","CR","CU","DM","DO","SV","GD","GT","HT","HN","JM","MX","NI","PA","KN","LC","VC","TT","US"],
  southamerica: ["AR","BO","BR","CL","CO","EC","GY","PY","PE","SR","UY","VE"],
  oceania:      ["AU","FJ","KI","MH","FM","NR","NZ","PW","PG","WS","SB","TO","TV","VU"],
  middleeast:   ["BH","CY","EG","IR","IQ","IL","JO","KW","LB","OM","PS","QA","SA","SY","TR","AE","YE"],
  caribbean:    ["AG","BS","BB","CU","DM","DO","GD","HT","JM","KN","LC","VC","TT"],
  centralasia:  ["KZ","KG","TJ","TM","UZ"],
  eastafrica:   ["BI","KM","DJ","ER","ET","KE","MG","MW","MU","MZ","RW","SC","SO","SS","TZ","UG","ZM","ZW"],
  westafrica:   ["BJ","BF","CV","CI","GM","GH","GN","GW","LR","ML","MR","MU","NE","NG","SN","SL","TG"],
  northafrica:  ["DZ","EG","LY","MA","SD","TN"],
  southafrica:  ["AO","BW","LS","MZ","NA","ZA","SZ","ZM","ZW"],
  global:[],world:[],international:[],
};

export const ISO_TO_KEY:Record<string,string> = {
  DZ:"algeria",AO:"angola",BJ:"benin",BW:"botswana",BF:"burkina_faso",BI:"burundi",CV:"cape_verde",CM:"cameroon",CF:"car",TD:"chad",KM:"comoros",CG:"congo",CD:"drc",DJ:"djibouti",EG:"egypt",GQ:"equatorial_guinea",ER:"eritrea",SZ:"eswatini",ET:"ethiopia",GA:"gabon",GM:"gambia",GH:"ghana",GN:"guinea",GW:"guinea_bissau",CI:"ivory_coast",KE:"kenya",LS:"lesotho",LR:"liberia",LY:"libya",MG:"madagascar",MW:"malawi",ML:"mali",MR:"mauritania",MU:"mauritius",MA:"morocco",MZ:"mozambique",NA:"namibia",NE:"niger",NG:"nigeria",RW:"rwanda",ST:"sao_tome",SN:"senegal",SC:"seychelles",SL:"sierra_leone",SO:"somalia",ZA:"south_africa",SS:"south_sudan",SD:"sudan",TG:"togo",TN:"tunisia",UG:"uganda",ZM:"zambia",ZW:"zimbabwe",TZ:"tanzania",
  AF:"afghanistan",AM:"armenia",AZ:"azerbaijan",BH:"bahrain",BD:"bangladesh",BT:"bhutan",BN:"brunei",KH:"cambodia",CN:"china",CY:"cyprus",GE:"georgia",IN:"india",ID:"indonesia",IR:"iran",IQ:"iraq",IL:"israel",JP:"japan",JO:"jordan",KZ:"kazakhstan",KP:"north_korea",KR:"south_korea",KW:"kuwait",KG:"kyrgyzstan",LA:"laos",LB:"lebanon",MY:"malaysia",MV:"maldives",MN:"mongolia",MM:"myanmar",NP:"nepal",OM:"oman",PK:"pakistan",PS:"palestine",PH:"philippines",QA:"qatar",SA:"saudi_arabia",SG:"singapore",LK:"sri_lanka",SY:"syria",TJ:"tajikistan",TH:"thailand",TL:"timor_leste",TR:"turkey",TM:"turkmenistan",AE:"uae",UZ:"uzbekistan",VN:"vietnam",YE:"yemen",
  AL:"albania",AD:"andorra",AT:"austria",BY:"belarus",BE:"belgium",BA:"bosnia",BG:"bulgaria",HR:"croatia",CZ:"czech_republic",DK:"denmark",EE:"estonia",FI:"finland",FR:"france",DE:"germany",GR:"greece",HU:"hungary",IS:"iceland",IE:"ireland",IT:"italy",XK:"kosovo",LV:"latvia",LI:"liechtenstein",LT:"lithuania",LU:"luxembourg",MT:"malta",MD:"moldova",MC:"monaco",ME:"montenegro",NL:"netherlands",MK:"north_macedonia",NO:"norway",PL:"poland",PT:"portugal",RO:"romania",RU:"russia",SM:"san_marino",RS:"serbia",SK:"slovakia",SI:"slovenia",ES:"spain",SE:"sweden",CH:"switzerland",UA:"ukraine",GB:"uk",VA:"vatican",
  AG:"antigua",BS:"bahamas",BB:"barbados",BZ:"belize",CA:"canada",CR:"costa_rica",CU:"cuba",DM:"dominica",DO:"dominican_republic",SV:"el_salvador",GD:"grenada",GT:"guatemala",HT:"haiti",HN:"honduras",JM:"jamaica",MX:"mexico",NI:"nicaragua",PA:"panama",KN:"saint_kitts",LC:"saint_lucia",VC:"saint_vincent",TT:"trinidad",US:"us",
  AR:"argentina",BO:"bolivia",BR:"brazil",CL:"chile",CO:"colombia",EC:"ecuador",GY:"guyana",PY:"paraguay",PE:"peru",SR:"suriname",UY:"uruguay",VE:"venezuela",
  AU:"australia",FJ:"fiji",KI:"kiribati",MH:"marshall_islands",FM:"micronesia",NR:"nauru",NZ:"new_zealand",PW:"palau",PG:"papua_new_guinea",WS:"samoa",SB:"solomon_islands",TO:"tonga",TV:"tuvalu",VU:"vanuatu",
};

export const NAME_ISO:Record<string,string> = {
  us:"US",usa:"US","united states":"US",america:"US","united states of america":"US",
  uk:"GB",gb:"GB","united kingdom":"GB",britain:"GB","great britain":"GB",england:"GB",scotland:"GB",wales:"GB",
  canada:"CA",ca:"CA",australia:"AU",au:"AU",oz:"AU",india:"IN","in":"IN",bharat:"IN",
  china:"CN",prc:"CN",japan:"JP",jp:"JP",nippon:"JP",germany:"DE",de:"DE",deutschland:"DE",
  france:"FR",fr:"FR",brazil:"BR",br:"BR",brasil:"BR",russia:"RU",ru:"RU",
  "south korea":"KR",korea:"KR","north korea":"KP",dprk:"KP",mexico:"MX",mx:"MX",
  indonesia:"ID",id:"ID",pakistan:"PK",pk:"PK",bangladesh:"BD",bd:"BD",
  nigeria:"NG",ng:"NG",ethiopia:"ET",et:"ET",egypt:"EG",eg:"EG",
  "democratic republic of congo":"CD",drc:"CD","dr congo":"CD",congo:"CG",
  tanzania:"TZ",tz:"TZ",kenya:"KE",ke:"KE",uganda:"UG",ug:"UG",ghana:"GH",gh:"GH",
  senegal:"SN",sn:"SN",rwanda:"RW",rw:"RW","south africa":"ZA",za:"ZA",
  morocco:"MA",ma:"MA",algeria:"DZ",dz:"DZ",tunisia:"TN",tn:"TN",libya:"LY",ly:"LY",
  sudan:"SD",sd:"SD","south sudan":"SS",ss:"SS",somalia:"SO",so:"SO",
  mozambique:"MZ",mz:"MZ",zimbabwe:"ZW",zw:"ZW",zambia:"ZM",zm:"ZM",malawi:"MW",mw:"MW",
  madagascar:"MG",mg:"MG",angola:"AO",ao:"AO",namibia:"NA",na:"NA",botswana:"BW",bw:"BW",
  cameroon:"CM",cm:"CM","ivory coast":"CI","cote d'ivoire":"CI",ci:"CI",mali:"ML",ml:"ML",
  niger:"NE",ne:"NE","burkina faso":"BF",bf:"BF",guinea:"GN",gn:"GN",benin:"BJ",bj:"BJ",
  togo:"TG",tg:"TG","sierra leone":"SL",sl:"SL",liberia:"LR",lr:"LR",gabon:"GA",ga:"GA",
  eritrea:"ER",er:"ER",djibouti:"DJ",dj:"DJ",mauritius:"MU",mu:"MU",seychelles:"SC",sc:"SC",
  "cape verde":"CV",cv:"CV",comoros:"KM",km:"KM",eswatini:"SZ",swaziland:"SZ",sz:"SZ",
  lesotho:"LS",ls:"LS",gambia:"GM",gm:"GM","guinea-bissau":"GW",gw:"GW",
  "equatorial guinea":"GQ",gq:"GQ",burundi:"BI",bi:"BI","sao tome":"ST",st:"ST",
  "central african republic":"CF",car:"CF",cf:"CF",chad:"TD",td:"TD",
  ukraine:"UA",ua:"UA",poland:"PL",pl:"PL",spain:"ES",es:"ES",italy:"IT",it:"IT",
  netherlands:"NL",nl:"NL",holland:"NL",belgium:"BE",be:"BE",sweden:"SE",se:"SE",
  norway:"NO",no:"NO",denmark:"DK",dk:"DK",finland:"FI",fi:"FI",switzerland:"CH",ch:"CH",
  austria:"AT",at:"AT",portugal:"PT",pt:"PT",greece:"GR",gr:"GR",romania:"RO",ro:"RO",
  hungary:"HU",hu:"HU","czech republic":"CZ",czechia:"CZ",cz:"CZ",slovakia:"SK",sk:"SK",
  croatia:"HR",hr:"HR",serbia:"RS",rs:"RS",bulgaria:"BG",bg:"BG","north macedonia":"MK",mk:"MK",
  albania:"AL",al:"AL",slovenia:"SI",si:"SI",montenegro:"ME",me:"ME",kosovo:"XK",xk:"XK",
  "bosnia and herzegovina":"BA",bosnia:"BA",ba:"BA",moldova:"MD",md:"MD",belarus:"BY",by:"BY",
  latvia:"LV",lv:"LV",lithuania:"LT",lt:"LT",estonia:"EE",ee:"EE",iceland:"IS",is:"IS",
  ireland:"IE",ie:"IE",luxembourg:"LU",lu:"LU",malta:"MT",mt:"MT",cyprus:"CY",cy:"CY",
  georgia:"GE",ge:"GE",armenia:"AM",am:"AM",azerbaijan:"AZ",az:"AZ",
  turkey:"TR",turkiye:"TR",tr:"TR",iran:"IR",ir:"IR",iraq:"IQ",iq:"IQ",
  "saudi arabia":"SA",sa:"SA",uae:"AE",ae:"AE","united arab emirates":"AE",
  qatar:"QA",qa:"QA",kuwait:"KW",kw:"KW",bahrain:"BH",bh:"BH",oman:"OM",om:"OM",
  jordan:"JO",jo:"JO",lebanon:"LB",lb:"LB",israel:"IL",il:"IL",palestine:"PS",ps:"PS",
  syria:"SY",sy:"SY",yemen:"YE",ye:"YE",afghanistan:"AF",af:"AF",
  "sri lanka":"LK",lk:"LK",ceylon:"LK",nepal:"NP",np:"NP",bhutan:"BT",bt:"BT",
  maldives:"MV",mv:"MV",myanmar:"MM",burma:"MM",mm:"MM",thailand:"TH",th:"TH",
  vietnam:"VN",vn:"VN",cambodia:"KH",kh:"KH",laos:"LA",la:"LA",malaysia:"MY",my:"MY",
  singapore:"SG",sg:"SG",philippines:"PH",ph:"PH","timor-leste":"TL","east timor":"TL",tl:"TL",
  brunei:"BN",bn:"BN",mongolia:"MN",mn:"MN",kazakhstan:"KZ",kz:"KZ",uzbekistan:"UZ",uz:"UZ",
  tajikistan:"TJ",tj:"TJ",turkmenistan:"TM",tm:"TM",kyrgyzstan:"KG",kg:"KG",
  "new zealand":"NZ",nz:"NZ","papua new guinea":"PG",png:"PG",pg:"PG",fiji:"FJ",fj:"FJ",
  argentina:"AR",ar:"AR",chile:"CL",cl:"CL",colombia:"CO",co:"CO",venezuela:"VE",ve:"VE",
  peru:"PE",pe:"PE",ecuador:"EC",ec:"EC",bolivia:"BO",bo:"BO",paraguay:"PY",py:"PY",
  uruguay:"UY",uy:"UY",guyana:"GY",gy:"GY",suriname:"SR",sr:"SR",cuba:"CU",cu:"CU",
  jamaica:"JM",jm:"JM",haiti:"HT",ht:"HT","dominican republic":"DO","do":"DO",
  "trinidad and tobago":"TT",trinidad:"TT",tt:"TT",barbados:"BB",bb:"BB",
  "antigua and barbuda":"AG",antigua:"AG",ag:"AG",grenada:"GD",gd:"GD",
  "saint lucia":"LC","st lucia":"LC",lc:"LC","saint kitts and nevis":"KN","st kitts":"KN",kn:"KN",
  "saint vincent":"VC","st vincent":"VC",vc:"VC",dominica:"DM",dm:"DM",
  bahamas:"BS",bs:"BS",belize:"BZ",bz:"BZ","costa rica":"CR",cr:"CR",
  "el salvador":"SV",sv:"SV",guatemala:"GT",gt:"GT",honduras:"HN",hn:"HN",
  nicaragua:"NI",ni:"NI",panama:"PA",pa:"PA",
};

const GL:Record<string,string> = {
  US:"US",GB:"GB",CA:"CA",AU:"AU",IN:"IN",DE:"DE",FR:"FR",JP:"JP",BR:"BR",MX:"MX",RU:"RU",CN:"CN",KR:"KR",IT:"IT",ES:"ES",NL:"NL",SE:"SE",NO:"NO",DK:"DK",FI:"FI",PL:"PL",PT:"PT",BE:"BE",AT:"AT",CH:"CH",IE:"IE",NZ:"NZ",ZA:"ZA",NG:"NG",KE:"KE",GH:"GH",EG:"EG",MA:"MA",TZ:"TZ",UG:"UG",ET:"ET",SN:"SN",TN:"TN",TR:"TR",SA:"SA",AE:"AE",IL:"IL",PK:"PK",BD:"BD",LK:"LK",MY:"MY",SG:"SG",PH:"PH",TH:"TH",VN:"VN",ID:"ID",AR:"AR",CL:"CL",CO:"CO",PE:"PE",VE:"VE",UA:"UA",RO:"RO",HU:"HU",CZ:"CZ",GR:"GR",HR:"HR",SK:"SK",BG:"BG",RS:"RS",KZ:"KZ",BY:"BY",AZ:"AZ",GE:"GE",AM:"AM",
  DZ:"EG",LY:"EG",SD:"EG",SS:"KE",SO:"KE",ER:"ET",DJ:"ET",CM:"NG",CI:"NG",ML:"NG",NE:"NG",BF:"NG",BJ:"NG",TG:"NG",GN:"NG",SL:"NG",LR:"NG",GW:"NG",GM:"SN",RW:"KE",BI:"KE",MZ:"ZA",ZM:"ZA",ZW:"ZA",BW:"ZA",NA:"ZA",LS:"ZA",SZ:"ZA",MG:"ZA",MW:"ZA",MU:"ZA",SC:"ZA",KM:"ZA",AO:"ZA",GA:"NG",CG:"NG",CD:"NG",CF:"NG",TD:"NG",GQ:"NG",ST:"NG",IR:"AE",IQ:"AE",JO:"AE",KW:"AE",BH:"AE",QA:"AE",OM:"AE",LB:"AE",SY:"AE",YE:"AE",PS:"IL",AF:"IN",NP:"IN",BT:"IN",MV:"IN",MM:"IN",KH:"TH",LA:"TH",BN:"MY",TL:"ID",MN:"CN",KP:"KR",UZ:"KZ",TJ:"KZ",TM:"KZ",KG:"KZ",CY:"GR",MT:"IT",LU:"BE",MC:"FR",LI:"CH",AD:"ES",SM:"IT",VA:"IT",AL:"GR",MK:"GR",ME:"RS",BA:"RS",XK:"RS",MD:"RO",LV:"FI",LT:"FI",EE:"FI",IS:"SE",CU:"MX",JM:"MX",HT:"MX",DO:"MX",TT:"MX",BB:"MX",GD:"MX",LC:"MX",KN:"MX",VC:"MX",DM:"MX",AG:"MX",BS:"MX",CR:"MX",BZ:"MX",SV:"MX",GT:"MX",HN:"MX",NI:"MX",PA:"MX",BO:"AR",PY:"AR",UY:"AR",GY:"BR",SR:"BR",EC:"CO",FJ:"AU",PG:"AU",NR:"AU",KI:"AU",MH:"AU",FM:"AU",PW:"AU",WS:"AU",SB:"AU",TO:"AU",TV:"AU",VU:"AU",
};

const LANG:Record<string,string> = {
  US:"en",GB:"en",CA:"en",AU:"en",IN:"hi",NG:"en",KE:"en",GH:"en",ZA:"en",UG:"en",TZ:"en",RW:"en",ET:"en",ZW:"en",ZM:"en",DE:"de",AT:"de",FR:"fr",BE:"fr",LU:"fr",ES:"es",MX:"es",AR:"es",CO:"es",PE:"es",CL:"es",VE:"es",PT:"pt",BR:"pt",IT:"it",RU:"ru",UA:"uk",PL:"pl",NL:"nl",SE:"sv",NO:"nb",DK:"da",FI:"fi",JP:"ja",KR:"ko",CN:"zh-Hans",TR:"tr",SA:"ar",AE:"ar",EG:"ar",MA:"ar",DZ:"ar",TN:"ar",BD:"bn",PK:"ur",ID:"id",MY:"ms",TH:"th",VN:"vi",GR:"el",CZ:"cs",SK:"sk",HU:"hu",RO:"ro",BG:"bg",HR:"hr",RS:"sr",AL:"sq",MK:"mk",
};

export const normalizeRegion       = (i:string) => (i??"").toLowerCase().trim().replace(/[^a-z0-9]/g,"");
export const getRegionKey          = (r:string) => ISO_TO_KEY[r.toUpperCase()] ?? r.toLowerCase();
export const getCountryCode        = (r:string) => (NAME_ISO[r.toLowerCase()] ?? "US").toLowerCase();
export const getGoogleNewsRegionCode=(r:string) => NAME_ISO[r.toLowerCase()] ?? r.toUpperCase() ?? "US";
export const getGoogleNewsGL       = (iso:string) => GL[iso.toUpperCase()] ?? "US";
export const getLangForCountry     = (iso:string) => LANG[iso.toUpperCase()] ?? "en";

export function detectRegionFromQuery(q:string):string {
  const lq = q.toLowerCase();
  for (const a of Object.keys(regionMap)) if (new RegExp(`\\b${a}\\b`,"i").test(lq)) return a;
  for (const [n,iso] of Object.entries(NAME_ISO)) if (new RegExp(`\\b${n}\\b`,"i").test(lq)) return iso.toLowerCase();
  return "";
}
export function getISOsForRegion(r:string):string[] {
  const up = r.toUpperCase();
  if (ISO_TO_KEY[up]) return [up];
  const codes = regionMap[r.toLowerCase()];
  if (codes?.length) return codes;
  const iso = NAME_ISO[r.toLowerCase()];
  return iso ? [iso] : ["US"];
}
export function buildGoogleNewsURLs(topic:string, regionKey:string):string[] {
  const isos = getISOsForRegion(regionKey);
  const targets = (!isos.length || ["global","world","international"].includes(regionKey))
    ? ["US","GB","IN","AU","CA","DE","FR","BR","ZA","NG","KE","JP","CN","MX","AE","PL","UA","TR","AR","SG"]
    : isos.slice(0,20);
  return [...new Set(targets.map(iso => getGoogleNewsGL(iso)))].map(gl => {
    const lang = getLangForCountry(gl);
    return `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=${lang}&gl=${gl}&ceid=${gl}:${lang}`;
  });
}