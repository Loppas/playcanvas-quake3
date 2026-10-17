import { describe, expect, it } from 'vitest';

import { ClientClock, UserCmdRing } from './client-clock';
import { createNetUserCmd, type NetUserCmd } from './protocol';

/** A clock that had its first snapshot, at `snapTime`, when the client's time was `realtime`. */
function started(realtime: number, snapTime: number): ClientClock {
  const clock = new ClientClock();
  clock.realtime = realtime;
  clock.firstSnapshot(snapTime);
  clock.run(snapTime, 0);
  return clock;
}

describe('ClientClock', () => {
  it('starts exactly on the first snapshot', () => {
    const clock = started(1000, 5000);
    expect(clock.serverTime).toBe(5000);
    expect(clock.serverTimeDelta).toBe(4000);
    expect(clock.jumped).toBe(true);
  });

  it('backs off two when it came near the newest snapshot, and creeps on one if not', () => {
    // On the snapshot is within 5 ms of it.
    const clock = started(1000, 5000);
    expect(clock.adjustTimeDelta(5000)).toBe('3998');

    // 50 ms on, as Quake 3's 20 a second come, and the clock 2 ms short of it: still near.
    clock.realtime += 50;
    clock.run(5050, 0);
    expect(clock.serverTime).toBe(5048);
    expect(clock.adjustTimeDelta(5050)).toBe('3996');

    // 4 ms short of the next, and then 6 ms short, which is far enough to creep on.
    clock.realtime += 50;
    clock.run(5100, 0);
    expect(clock.adjustTimeDelta(5100)).toBe('3994');
    clock.realtime += 50;
    clock.run(5150, 0);
    expect(clock.serverTime).toBe(5144);
    expect(clock.adjustTimeDelta(5150)).toBe('3995');
  });

  it('takes a share of the step for a snapshot sooner than 50 ms, and never more than it', () => {
    const clock = started(1000, 5000);
    clock.adjustTimeDelta(5000);

    // 8 ms on and near: 8/50 of the two.
    clock.realtime += 8;
    clock.run(5008, 0);
    clock.adjustTimeDelta(5008);
    expect(clock.serverTimeDelta).toBeCloseTo(3998 - 0.32, 10);

    // A snapshot 32 ms after the last, and far: 32/50 of the one.
    clock.realtime += 8;
    clock.run(5040, 0);
    clock.adjustTimeDelta(5040);
    expect(clock.serverTimeDelta).toBeCloseTo(3998 - 0.32 + 0.64, 10);

    // One 160 ms after it, which is Quake 3's whole step and no more.
    clock.realtime += 100;
    clock.run(5200, 0);
    expect(clock.adjustTimeDelta(5200)).toBe('3999');
    expect(clock.serverTimeDelta).toBeCloseTo(3998 - 0.32 + 0.64 + 1, 10);
  });

  it('halves a difference over 100 ms, and takes one over 500 ms at once', () => {
    const clock = started(1000, 5000);
    expect(clock.adjustTimeDelta(5200)).toBe('<FAST> 4100');
    clock.jumped = false;

    expect(clock.adjustTimeDelta(6000)).toBe('<RESET> 5000');
    expect(clock.serverTime).toBe(6000);
    // The commands start again from the step it is in now.
    expect(clock.jumped).toBe(true);
  });

  it('never runs back, however the offset or the nudge moves', () => {
    const clock = started(1000, 5000);
    clock.adjustTimeDelta(4900);
    clock.run(4900, 0);
    expect(clock.serverTime).toBe(5000);

    clock.realtime += 8;
    clock.run(4900, 30);
    expect(clock.serverTime).toBe(5000);
  });

  it('holds cl_timeNudge to 30 either way', () => {
    const clock = started(1000, 5000);
    clock.realtime += 100;
    clock.run(5100, 100);
    expect(clock.serverTime).toBe(5100 - 30);

    const ahead = started(1000, 5000);
    ahead.run(5000, -100);
    expect(ahead.serverTime).toBe(5000 + 30);
  });

  it('clears with a new gamestate, all but its own time', () => {
    const clock = started(1000, 5000);
    clock.clear();
    expect(clock.realtime).toBe(1000);
    expect(clock.serverTime).toBe(0);
    expect(clock.serverTimeDelta).toBe(0);
    expect(clock.jumped).toBe(false);

    // And the snapshot it last moved for: the new world's first moves it Q3's whole step.
    const again = started(1000, 5000);
    again.adjustTimeDelta(5000);
    again.clear();
    again.firstSnapshot(5008);
    again.run(5008, 0);
    expect(again.adjustTimeDelta(5008)).toBe('4006');
  });
});

describe('UserCmdRing', () => {
  /** A clock at a server time, as the ring reads it. */
  function at(serverTime: number, jumped = false): ClientClock {
    const clock = new ClientClock();
    clock.serverTime = serverTime;
    clock.jumped = jumped;
    return clock;
  }

  function input(fields: Partial<NetUserCmd> = {}): NetUserCmd {
    return { ...createNetUserCmd(), ...fields };
  }

  /** The times of every command made, oldest first. */
  function times(ring: UserCmdRing): number[] {
    const out: number[] = [];
    for (let n = 1; n <= ring.cmdNumber; n++) out.push(ring.at(n).serverTime);
    return out;
  }

  it("makes one command a step, stamped with the step's end on the server's grid", () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1003, true), true, 8);
    ring.createNewCommands(input(), at(1005), true, 8);
    ring.createNewCommands(input(), at(1008), true, 8);
    ring.createNewCommands(input(), at(1009), true, 8);
    ring.createNewCommands(input(), at(1016), true, 8);
    ring.createNewCommands(input(), at(1017), true, 8);
    expect(times(ring)).toEqual([1008, 1016, 1024]);
  });

  it('makes several in a long frame, all with its input, and no more than 200 ms of them', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1008, true), true, 8);
    ring.createNewCommands(input({ forwardmove: 127 }), at(1040), true, 8);
    expect(times(ring)).toEqual([1008, 1016, 1024, 1032, 1040]);
    expect([2, 3, 4, 5].map((n) => ring.at(n).forwardmove)).toEqual([127, 127, 127, 127]);

    ring.createNewCommands(input(), at(5000), true, 8);
    const made = times(ring).slice(5);
    expect(made).toHaveLength(25);
    expect(made[0]).toBe(5000 - 24 * 8);
    expect(made.at(-1)).toBe(5000);
  });

  it('starts again from the step the clock is in when it is set rather than run', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1008, true), true, 8);
    ring.createNewCommands(input(), at(9000, true), true, 8);
    ring.createNewCommands(input(), at(900, true), true, 8);
    expect(times(ring)).toEqual([1008, 9000, 904]);
  });

  it('carries a button pressed in a frame that made no command into the next command', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1008, true), true, 8);
    ring.createNewCommands(input({ buttons: 1 }), at(1008), true, 8);
    ring.createNewCommands(input(), at(1012), true, 8);
    ring.createNewCommands(input(), at(1020), true, 8);
    expect([2, 3].map((n) => ring.at(n).buttons)).toEqual([1, 0]);
  });

  it('makes a command a frame before the clock runs, on whatever time it stands at', () => {
    const ring = new UserCmdRing();
    for (let i = 0; i < 3; i++) ring.createNewCommands(input(), at(0), false, 8);
    expect(times(ring)).toEqual([0, 0, 0]);
  });

  it('keeps 64 commands', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(8, true), true, 8);
    for (let t = 16; t <= 65 * 8; t += 8) ring.createNewCommands(input(), at(t), true, 8);
    expect(ring.cmdNumber).toBe(65);
    expect(ring.at(65).serverTime).toBe(520);
    // The first has been written over by the sixty-fifth.
    expect(ring.at(1)).toBe(ring.at(65));
  });

  it("steps by whatever pmove_msec is, on that step's grid", () => {
    const sixteen = new UserCmdRing();
    sixteen.createNewCommands(input(), at(1003, true), true, 16);
    sixteen.createNewCommands(input(), at(1009), true, 16);
    sixteen.createNewCommands(input(), at(1017), true, 16);
    sixteen.createNewCommands(input(), at(1030), true, 16);
    expect(times(sixteen)).toEqual([1008, 1024, 1040]);

    const eleven = new UserCmdRing();
    eleven.createNewCommands(input(), at(1003, true), true, 11);
    eleven.createNewCommands(input(), at(1013), true, 11);
    expect(times(eleven)).toEqual([1012, 1023]);
  });

  it('puts the first command after a change of step on the new grid, after the last', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1009, true), true, 8);
    ring.createNewCommands(input(), at(1030), true, 16);
    ring.createNewCommands(input(), at(1041), true, 8);
    expect(times(ring)).toEqual([1016, 1024, 1040, 1048]);
  });

  it('makes no more than 200 ms of commands in a frame at a longer step', () => {
    const ring = new UserCmdRing();
    ring.createNewCommands(input(), at(1008, true), true, 16);
    ring.createNewCommands(input(), at(5000), true, 16);
    const made = times(ring).slice(1);
    expect(made).toHaveLength(12);
    expect(made[0]).toBe(5008 - 11 * 16);
    expect(made.at(-1)).toBe(5008);
  });
});
