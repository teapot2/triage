import { duration, type UptimeCheck, type UptimeRule, type UptimeSample } from "./model";

// How an uptime check is judged from its saved samples: its status, its
// streaks, and whether Slow or Down trips. Pure, and counted from the
// samples alone, so a restart judges exactly as before it.

export type CheckJudgment = {
  status: "healthy" | "slow" | "unavailable" | "unchecked";
  // Slow samples in a row, newest back. A timeout is down, so it breaks the
  // streak instead of adding to it.
  slowStreak: number;
  // When the unbroken run of down samples ending at the newest began.
  downSince?: string;
  // Ok samples in a row, newest back: what confirms a recovery.
  healthyStreak: number;
  trip?: UptimeRule;
  // "slow, check 2 of 3", "down 3 of 5 min", "200 in 184 ms".
  summary?: string;
};

// Samples newest last, as samples.ts keeps them; any after `now` are ignored.
export function judgeCheck(check: UptimeCheck, samples: UptimeSample[], now: number): CheckJudgment {
  const seen = samples.filter((s) => Date.parse(s.at) <= now);
  const last = seen.at(-1);
  if (!last) return { status: "unchecked", slowStreak: 0, healthyStreak: 0, summary: "not checked yet" };

  const streak = (outcome: UptimeSample["outcome"]) => {
    let n = 0;
    for (let i = seen.length - 1; i >= 0 && seen[i].outcome === outcome; i--) n++;
    return n;
  };
  const slowStreak = streak("slow");
  const healthyStreak = streak("ok");
  const downStreak = streak("down");
  const downSince = downStreak ? seen[seen.length - downStreak].at : undefined;
  const downMinutes = downSince ? (now - Date.parse(downSince)) / 60_000 : 0;

  // Both can't hold on the same samples (the newest is slow or down), but
  // Down is the outage, so it's asked first.
  const trip: UptimeRule | undefined =
    downSince && downMinutes >= check.downMinutesToOpen
      ? "down"
      : slowStreak >= check.slowChecksToOpen
        ? "slow"
        : undefined;

  switch (last.outcome) {
    case "ok":
      return { status: "healthy", slowStreak, healthyStreak, trip, summary: `${last.status} in ${duration(last.ms)}` };
    case "slow": {
      const n = check.slowChecksToOpen;
      const summary = slowStreak <= n ? `slow, check ${slowStreak} of ${n}` : `slow, ${slowStreak} checks in a row`;
      return { status: "slow", slowStreak, healthyStreak, trip, summary };
    }
    case "down": {
      const m = Math.floor(downMinutes);
      const window = check.downMinutesToOpen;
      const summary = m < window ? `down ${m} of ${window} min` : `down ${m} min`;
      return { status: "unavailable", slowStreak, downSince, healthyStreak, trip, summary };
    }
  }
}
