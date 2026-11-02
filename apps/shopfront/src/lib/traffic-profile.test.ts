import { describe, expect, it } from "vitest";
import { normalizeProfile, presets } from "./traffic-profile";

// A preset the server would alter can never show as the one in use on /ops,
// and the traffic it sends would not be what its description says.
describe("traffic presets", () => {
  for (const preset of presets) {
    it(`${preset.name} survives normalization unchanged`, () => {
      expect(normalizeProfile(preset.profile)).toEqual(preset.profile);
    });
  }
});
