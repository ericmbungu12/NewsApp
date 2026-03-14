// supabase/functions/fetch-news/region.ts

export const regionMap: Record<string, string[]> = {
  africa:       ["DZ","AO","BJ","BW","BF","BI","CV","CM","CF","TD","KM","CG","CD","DJ","EG","GQ","ER","SZ","ET","GA","GM","GH","GN","GW","CI","KE","LS","LR","LY","MG","MW","ML","MR","MU","MA","MZ","NA","NE","NG","RW","ST","SN","SC","SL","SO","ZA","SS","SD","TG","TN","UG","ZM","ZW"],
  asia:         ["AF","AM","AZ","BH","BD","BT","BN","KH","CN","CY","GE","IN","ID","IR","IQ","IL","JP","JO","KZ","KP","KR","KW","KG","LA","LB","MY","MV","MN","MM","NP","OM","PK","PS","PH","QA","SA","SG","LK","SY","TJ","TH","TL","TR","TM","AE","UZ","VN","YE"],
  europe:       ["AL","AD","AM","AT","AZ","BY","BE","BA","BG","HR","CY","CZ","DK","EE","FI","FR","GE","DE","GR","HU","IS","IE","IT","KZ","XK","LV","LI","LT","LU","MT","MD","MC","ME","NL","MK","NO","PL","PT","RO","RU","SM","RS","SK","SI","ES","SE","CH","UA","GB","VA"],
  northamerica: ["AG","BS","BB","BZ","CA","CR","CU","DM","DO","SV","GD","GT","HT","HN","JM","MX","NI","PA","KN","LC","VC","TT","US"],
  southamerica: ["AR","BO","BR","CL","CO","EC","GY","PY","PE","SR","UY","VE"],
  oceania:      ["AU","FJ","KI","MH","FM","NR","NZ","PW","PG","WS","SB","TO","TV","VU"],
  global: [], world: [], international: [],
};

// ISO → display name (covers all single-country aliases)
const ISO_NAME: Record<string, string> = {
  US:"us", GB:"uk", CA:"canada", AU:"australia", IN:"india", KE:"kenya",
  UG:"uganda", TZ:"tanzania", RW:"rwanda", ET:"ethiopia", GH:"ghana", NG:"nigeria", SN:"senegal",
};

// name/alias → ISO
const NAME_ISO: Record<string, string> = {
  us:"US", usa:"US", "united states":"US", america:"US",
  uk:"GB", gb:"GB", "united kingdom":"GB", britain:"GB",
  ca:"CA", canada:"CA", au:"AU", australia:"AU",
  in:"IN", india:"IN", ke:"KE", kenya:"KE", ug:"UG", uganda:"UG",
  tz:"TZ", tanzania:"TZ", rw:"RW", rwanda:"RW", et:"ET", ethiopia:"ET",
  gh:"GH", ghana:"GH", ng:"NG", nigeria:"NG", sn:"SN", senegal:"SN",
};

export const normalizeRegion = (input: string) =>
  (input ?? "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");

export function detectRegionFromQuery(query: string): string {
  const q = query.toLowerCase();
  for (const [alias, codes] of Object.entries(regionMap))
    if (codes.length && new RegExp(`\\b${alias}\\b`, "i").test(q)) return alias;
  return "";
}

// Returns a consistent display key (e.g. "IN" → "india", "africa" → "africa")
export const getRegionKey = (r: string): string => ISO_NAME[r.toUpperCase()] ?? r;

// Returns lowercase ISO-2 code ("india" → "in"), falls back to "us"
export const getCountryCode = (r: string): string =>
  (NAME_ISO[r.toLowerCase()] ?? "US").toLowerCase();

// Returns uppercase ISO-2 code ("india" → "IN"), falls back to "US"
export const getGoogleNewsRegionCode = (r: string): string =>
  NAME_ISO[r.toLowerCase()] ?? "US";