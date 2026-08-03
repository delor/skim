// Eased scrolling for the j/k keys.
//
// A keypress used to jump the page one line instantly, which reads as a stutter
// when you hold the key down. Instead, each press adds its distance to a target
// and a rAF loop eases the page toward it: taps glide, and holding the key (the
// OS repeats it ~30x a second) turns into one continuous slide because the
// target keeps moving ahead of the animation.
//
// The step per frame is derived from elapsed time, not from a fixed fraction,
// so the motion runs at the same speed on a 60Hz and a 144Hz display.

// Time constant: the distance left shrinks by 1/e every TAU ms. Small enough to
// feel immediate, large enough to be a glide rather than a jump.
const TAU_MS = 85;

export function createSmoothScroller(env = {}) {
  const {
    getY = () => window.scrollY,
    setY = (y) => window.scrollTo(0, y),
    maxY = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    raf = (cb) => requestAnimationFrame(cb),
    now = () => performance.now(),
    tau = TAU_MS,
  } = env;

  let target = null;  // null means idle
  let position = 0;   // float: keeps the sub-pixel remainder a rounded scrollY would drop
  let applied = 0;    // what we last wrote, to notice scrolling from elsewhere
  let last = 0;

  const clamp = (y) => Math.min(Math.max(y, 0), maxY());

  function frame(t) {
    const dt = Math.min(Math.max(t - last, 0), 64); // ignore huge gaps (background tab)
    last = t;

    // The reader scrolled some other way mid-flight (wheel, scrollbar, a link).
    // Carry the remaining distance over from wherever they landed.
    const y = getY();
    if (Math.abs(y - applied) > 2) {
      const remaining = target - position;
      position = y;
      target = clamp(y + remaining);
    }

    position += (target - position) * (1 - Math.exp(-dt / tau));
    if (Math.abs(target - position) < 0.5) position = target;
    setY(position);
    applied = getY();

    if (position === target) { target = null; return; }
    raf(frame);
  }

  function aim(next) {
    const idle = target === null;
    if (idle) {
      position = getY();
      applied = position;
      target = position;
      last = now();
    }
    target = clamp(next(target));
    if (idle) raf(frame);
  }

  return {
    by(delta) { aim((t) => t + delta); },
    to(y) { aim(() => y); },
    get animating() { return target !== null; },
  };
}
