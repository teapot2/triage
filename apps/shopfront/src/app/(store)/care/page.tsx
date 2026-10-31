import type { Metadata } from "next";
import { InfoPage, InfoSectionBlock } from "@/components/info-page";

export const metadata: Metadata = { title: "Care guide" };

// One entry per material in the catalog, with the products made of it.
const materials = [
  {
    title: "Stoneware",
    pieces: "Mugs, bowls and plates",
    care: [
      "Dishwasher, microwave and oven safe.",
      "Avoid sudden changes in temperature: don't take a plate from the fridge straight into a hot oven.",
      "Matte glazes can pick up marks from cutlery. A little baking soda paste lifts them.",
    ],
  },
  {
    title: "Cast iron and enamel",
    pieces: "The teapot",
    care: [
      "Rinse with hot water after each use and dry it fully, inside and out, before putting the lid back on.",
      "No dish soap or dishwasher: the enamel inside doesn't need it.",
      "Never heat it empty or on the stove. It's for brewing, not boiling.",
    ],
  },
  {
    title: "Olive wood",
    pieces: "Cutting boards",
    care: [
      "Hand wash with warm, soapy water and stand it on its edge to dry.",
      "Oil it once a month with food-safe mineral oil or board butter, more often when it looks pale.",
      "Never soak it or put it in the dishwasher; that's what splits wood.",
    ],
  },
  {
    title: "Linen",
    pieces: "Tea towels and napkins",
    care: [
      "Machine wash warm (40 °C) with similar colors. Skip fabric softener; linen softens by itself.",
      "Line dry, or tumble dry low and take it out while still slightly damp.",
      "Creases are part of the look. If you'd rather not, iron it damp.",
    ],
  },
  {
    title: "Glass",
    pieces: "Storage jars and drinking glasses",
    care: [
      "The glass is dishwasher safe. The jars' oak lids are hand wash only; wipe the seal dry.",
      "Borosilicate jars take hot liquids, but warm them gently rather than pouring boiling water into a cold jar.",
    ],
  },
  {
    title: "Beeswax",
    pieces: "Pillar candles",
    care: [
      "Burn it for two hours the first time, so the melt pool reaches the edges and it burns evenly after.",
      "Trim the wick to about 6 mm before each lighting.",
      "A white bloom on the surface is natural. Polish it off with a soft cloth.",
    ],
  },
  {
    title: "Terracotta",
    pieces: "Planters",
    care: [
      "Soak a new pot in water for an hour before potting, so it doesn't draw all the moisture from the soil.",
      "Unglazed clay breathes, so plants dry out faster than in plastic. Water a little more often.",
      "It will develop a soft white patina from minerals in the water. Scrub it off, or let it be.",
    ],
  },
];

export default function CarePage() {
  return (
    <InfoPage
      section="Help"
      current="/care"
      title="Care guide"
      intro="Everything we sell is made to be used every day. A little care keeps it that way for years."
    >
      {materials.map((m) => (
        <InfoSectionBlock key={m.title} title={m.title} aside={m.pieces}>
          <ul>
            {m.care.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </InfoSectionBlock>
      ))}
    </InfoPage>
  );
}
