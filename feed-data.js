// Sample pool for design candidates. Shape mirrors the feed contract's item
// plus the site-only `_homepage.note`. Real items come from the generator.

export const items = [
  { id: "a1", source: "EMCrit", topic: "medicine", kind: "timely", date: "2026-09-04",
    title: "RV failure in the crashing patient",
    note: "Ties directly to the CCPU module you're partway through — the volume-vs-pressor call is the part most registrars get backwards.",
    hue: 12, read: false },
  { id: "a2", source: "LITFL", topic: "medicine", kind: "timely", date: "2026-09-04",
    title: "ECG of the week: subtle occlusion MI",
    note: "Three tracings that don't meet STEMI criteria and all three occluded. Worth ten minutes.",
    hue: 200, read: true },
  { id: "a3", source: "Broadsheet MEL", topic: "melbourne", kind: "timely", date: "2026-09-04",
    title: "A twelve-seat pasta counter opens in Thornbury",
    note: "Walking distance from you. No bookings, opens 5pm, expect a queue by six.",
    hue: 34, read: false },
  { id: "a4", source: "Eurogamer", topic: "gaming", kind: "timely", date: "2026-09-04",
    title: "The Witcher 4 gets a release window at last",
    note: "Late 2027, and the first real look at the engine change.",
    hue: 265, read: false },
  { id: "a5", source: "Mutimer", topic: "fashion", kind: "timely", date: "2026-09-04",
    title: "The moleskin chore coat is back in stock",
    note: "Sold out in a week last year. Ecru and olive only.",
    hue: 84, read: false },
  { id: "a6", source: "35mmc", topic: "photography", kind: "evergreen", date: "2026-09-04",
    title: "Portra 400 pushed two stops, honestly",
    note: "Someone finally shows the ugly frames alongside the good ones.",
    hue: 20, read: false },
  { id: "a7", source: "Owen Cuts", topic: "records", kind: "evergreen", date: "2026-09-04",
    title: "The pressing that ruined my ears",
    note: "On why the 2016 remaster of a record you own is the wrong one to keep.",
    hue: 320, read: false },

  { id: "b1", source: "First10EM", topic: "medicine", kind: "timely", date: "2026-09-03",
    title: "Lung ultrasound in undifferentiated dyspnoea",
    note: "A clean summary of what the probe can and can't settle at the bedside.",
    hue: 190, read: false },
  { id: "b2", source: "Heddels", topic: "fashion", kind: "evergreen", date: "2026-09-03",
    title: "How RRL manufactures ninety years of wear",
    note: "The processes behind the repro look, described by people who do it.",
    hue: 40, read: true },
  { id: "b3", source: "Time Out MEL", topic: "melbourne", kind: "evergreen", date: "2026-09-03",
    title: "Northside Sunday markets, ranked by what you'd actually buy",
    note: "Two you haven't been to, both under twenty minutes away.",
    hue: 140, read: false },
  { id: "b4", source: "Casual Photophile", topic: "photography", kind: "evergreen", date: "2026-09-03",
    title: "The Contax T2 in 2026, at 2026 prices",
    note: "Argues the T3 is the better buy and mostly convinces.",
    hue: 216, read: false },
  { id: "b5", source: "Keen Games", topic: "gaming", kind: "timely", date: "2026-09-03",
    title: "Enshrouded update 8: the farming rework",
    note: "Base-building changes that make a second playthrough worth it.",
    hue: 96, read: false },
  { id: "b6", source: "Aquarium Drunkard", topic: "records", kind: "evergreen", date: "2026-09-03",
    title: "Deep listening: the second side of Pharoah",
    note: "You own this. This is about the half you skip.",
    hue: 300, read: false },
  { id: "b7", source: "Tender Loving", topic: "other", kind: "evergreen", date: "2026-09-03",
    title: "Black-work tattooers in Melbourne worth the wait",
    note: "Four studios, all northside, all with open books this month.",
    hue: 0, read: false }
];

export const topics = ["medicine", "records", "photography", "fashion", "gaming", "melbourne", "other"];

export function group(list) {
  const byDate = {};
  list.forEach(i => { (byDate[i.date] = byDate[i.date] || []).push(i); });
  return Object.keys(byDate).sort().reverse().map(date => ({
    date,
    label: new Date(date + "T00:00:00Z").toLocaleDateString("en-AU",
      { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
    items: byDate[date]
  }));
}

export function apply(list, chip) {
  if (!chip) return list;
  if (chip === "read") return list.filter(i => i.read);
  if (chip === "timely" || chip === "evergreen") return list.filter(i => i.kind === chip);
  return list.filter(i => i.topic === chip);
}
