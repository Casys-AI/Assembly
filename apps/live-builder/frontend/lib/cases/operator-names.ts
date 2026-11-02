import { monogram } from "../workbench/desk.ts";
import { type CaseRecord, caseTitle } from "./cases.ts";

/**
 * Invented names, ten per initial: letters only, so a two-word name's
 * monogram is its two initials.
 */
const NAMES: Readonly<Record<string, string>> = {
  A: "Aldrek Amarek Arvoth Asheva Avonix Azelan Akhesh Altunar Anzari Avrelle",
  B: "Belzar Bravik Brontal Bhessa Brevok Bazrel Bolenti Brakhis Byrran Bolvesh",
  C: "Calvrek Cerisan Corrinax Cydonel Chaveth Cassorin Cendrix Crathis Cyrevan Callixa",
  D: "Darvok Delmira Dorvane Draxen Dhuvar Delkari Dressik Durelis Dyrrak Dumorra",
  E: "Elvarek Esmara Ethrin Ezvalon Endrevi Eskavar Elorith Evanthi Erraxos Ekrevan",
  F: "Falvrek Feronis Fendrax Firella Forvan Fhessik Fallodri Ferazin Fyrenth Folmara",
  G: "Galvesh Gerranth Gorvik Ghelani Gavrossa Grethal Gilvane Gyrek Galdessa Gremosh",
  H: "Halvrek Heskara Hovrath Hendrel Hyralis Haskovar Helmira Hurrak Hathenor Hessavi",
  I: "Ilvaren Isketh Ivorra Ithanel Irrakos Izmeri Ilsodar Isharra Ithrix Ixalon",
  J: "Javrek Jessara Jorvane Jhelan Juvari Jaskorin Jethra Jolvessa Jurrak Jodrakis",
  K: "Kelvrak Korvessa Kathrel Khevan Kendrax Kyrolis Kessavan Kuvrek Kalimere Kethos",
  L: "Lavrek Lessorin Lorquen Lhedra Lyrrani Lasketh Lumerra Lothvane Lazmira Lukhari",
  M: "Margature Mervani Morvash Melkira Mhordan Myrrelis Malvek Mossara Mythren Mezrathi",
  N: "Navrek Nessara Nordessan Nhalik Nevrith Nyssovar Naskel Nimoren Nothari Nalevra",
  O: "Orquelin Olvessa Oskarel Ombrith Ondrex Oyrali Ozmeran Ovelline Orrakesh Othelan",
  P: "Pashvel Peressa Porvane Phessari Pendrax Pyrolin Pakhoth Pemiral Pruvesk Podrakel",
  Q: "Qorvane Quessara Qelthan Qiravel Quendrix Qusari Qavrolin Quillek Qethra Qyronel",
  R: "Ravrek Ressani Rhedrix Rylessa Raskovar Remurin Rothven Rukhal Rizhenne Rennaquel",
  S: "Sathrek Sessarin Shevrali Sendrix Syrolis Saskeval Semirra Selvoth Suvrakin Szodrak",
  T: "Talvrek Tessara Thelvix Tendrax Tyrolis Taskhan Temurel Trevanni Tirathel Tozrin",
  U: "Ulvarek Usmara Urveth Uzhalon Undrevi Uskavar Ulorith Uvanthi Umbrisar Uthenor",
  V: "Valdrex Vessira Vorlane Vhenik Vendari Vyrrosh Vaskel Vemorra Vothrin Velkassa",
  W: "Wolvrek Wessandi Worthak Whelaxi Wendrel Wyrossa Wakhesh Wemirel Wothari Wirrenta",
  X: "Xalvrek Xessara Xorvane Xhelan Xendrix Xyrolis Xaskeva Xemirra Xothren Xurrak",
  Y: "Yalveth Yessorin Yorvaxi Yhelan Yendrel Ysolis Yaskhar Yemirra Yothrel Yurrakesh",
  Z: "Zalvrek Zessara Zorvane Zhelan Zendrix Zyrolis Zaskeva Zemirra Zothren Zurrak",
};

/** The invented names of each initial, A to Z. */
export const OPERATOR_NAMES: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(NAMES).map(([key, names]) => [key, names.split(" ")]),
  );

/** The generic name a Request's conversation gives the operator it runs. */
export const GENERIC_BRANCH_NAME = "Branch Operator";

/** FNV-1a: a Case's id always draws the same words. */
function seed(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The name a Case's Branch Operator goes by: two invented words on the Case's
 * initials ("Qualification MVP…" → "Qorvane Margature"), drawn by its id, so
 * its avatar stays those initials. Initials outside A–Z (digits, other
 * scripts) stay its name.
 */
export function branchOperatorName(
  record: Pick<CaseRecord, "id" | "objective">,
): string {
  const initials = monogram(caseTitle(record));
  const [first, second] = [...initials].map((char) =>
    OPERATOR_NAMES[
      char.normalize("NFD").replace(/\p{M}/gu, "").toLocaleUpperCase()
    ]
  );
  if (!first || !second) return initials;
  const hash = seed(record.id);
  const one = hash % first.length;
  // On doubled initials ("MM"), the second word is another one.
  const rest = first === second
    ? second.filter((_, index) => index !== one)
    : second;
  return `${first[one]} ${rest[Math.floor(hash / first.length) % rest.length]}`;
}

/**
 * What a Request's conversation calls its operator: the generic name gives
 * way to its Branch Operator's; a custom name is kept.
 */
export const caseOperatorName = (
  name: string,
  record: Pick<CaseRecord, "id" | "objective"> | null | undefined,
): string =>
  name === GENERIC_BRANCH_NAME && record ? branchOperatorName(record) : name;
