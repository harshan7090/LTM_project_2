/* Corvex — landing page behaviour.
 *
 * EXTERNAL FOR A REASON
 *
 *   The console sends `Content-Security-Policy: script-src 'self'`, which
 *   blocks inline <script>. An earlier version kept its JavaScript inline,
 *   the browser refused to run any of it, every .reveal stayed at opacity 0,
 *   and the page shipped as a black screen with only the header showing.
 *   Serving from the same origin satisfies the policy with no weakening.
 *
 * WHERE THE SMOOTHNESS COMES FROM
 *
 *   Not from more animation. Reading raw scrollY and writing it straight to
 *   a transform is perfectly accurate and feels cheap, because a trackpad
 *   delivers scroll in jagged discrete steps and the element reproduces
 *   every one of them.
 *
 *   So the scroll position is DAMPED: a target follows the real scroll
 *   instantly, and a rendered value eases toward it a fixed fraction per
 *   frame. The scene always lags slightly and always arrives, which is what
 *   reads as weight. One constant sets the feel of the whole page.
 *
 *   The page itself is never hijacked. Native scrolling stays exactly as the
 *   browser implements it — only the 3D scene is damped. Overriding real
 *   scrolling breaks keyboard paging, find-in-page and screen readers, which
 *   is far too high a price for a visual effect.
 *
 * WHAT WAS REMOVED
 *
 *   This file used to build a depot map, a segment yard, a pressure gauge
 *   and a cross-section — for sections that no longer exist in the markup.
 *   All of it ran on every load, found nothing, and did nothing.
 */
(function () {
  'use strict';

  var doc = document;
  doc.documentElement.classList.remove('no-js');

  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Fraction of the remaining distance closed each frame. Lower is heavier.
     0.075 lags about a fifth of a second behind a flick, which is the point
     where motion reads as mass rather than as lag. */
  var LERP = 0.075;

  var target = 0;    // where the page really is, 0..1
  var current = 0;   // what is drawn, chasing target

  var header = doc.getElementById('header');
  var railPig = doc.getElementById('rail-pig');
  var railPct = doc.getElementById('rail-pct');
  var heroCopy = doc.getElementById('hero-copy');
  var hero = doc.getElementById('hero');
  var planes = [
    { el: doc.querySelector('.env-far'),  rate: 0.10 },
    { el: doc.querySelector('.env-mid'),  rate: 0.26 },
    { el: doc.querySelector('.env-near'), rate: 0.52 }
  ].filter(function (pl) { return pl.el; });

  /* ------------------------------------------------------ 3D scene ---- */
  /* If the context cannot be created the canvas is removed outright, which
     uncovers the flat CSS pipe beneath it. An empty <canvas> left in place
     would be a hole in the hero. */
  var canvas = doc.getElementById('pipe-gl');
  var scene = null;
  if (canvas && window.CorvexPipe) {
    scene = window.CorvexPipe.create(canvas, reduced);
  }
  if (scene) {
    doc.documentElement.classList.add('gl-on');
  } else if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }

  /* -------------------------------------------------- scroll driver ---- */

  function readScroll() {
    var y = window.pageYOffset || doc.documentElement.scrollTop || 0;
    var h = Math.max(1, doc.body.scrollHeight - window.innerHeight);
    target = Math.min(1, Math.max(0, y / h));
    if (header) header.classList.toggle('scrolled', y > 20);

    /* Hero copy lifts and fades as it leaves, so the 3D scene is uncovered
       rather than scrolled off behind text. Driven by the hero's own height,
       not the whole page, so it finishes exactly as the hero does. */
    if (heroCopy && hero && !reduced) {
      var k = Math.min(1, y / Math.max(1, hero.offsetHeight * 0.72));
      heroCopy.style.opacity = String(1 - k);
      heroCopy.style.transform = 'translate3d(0,' + (-k * 70).toFixed(1) + 'px,0)';
    }
  }

  function frame() {
    var gap = target - current;
    /* Snap when the gap is imperceptible, so the loop is not forever
       writing sub-pixel values that never settle. */
    current += Math.abs(gap) < 0.0002 ? gap : gap * LERP;

    if (scene) scene.setProgress(current);

    /* Parallax. Each plane moves at its own rate, so the horizon lags and
       the near rack races - that difference is the depth cue. Driven by the
       DAMPED value, not raw scroll, so the planes carry the same weight as
       the 3D scene instead of twitching a frame ahead of it. */
    if (!reduced) {
      for (var i = 0; i < planes.length; i++) {
        planes[i].el.style.transform =
          'translate3d(0,' + (current * planes[i].rate * 260).toFixed(1) + 'px,0)';
      }
    }

    if (railPig) railPig.style.top = (current * 100).toFixed(2) + '%';
    if (railPct) railPct.textContent = String(Math.round(current * 100)).padStart(2, '0');

    window.requestAnimationFrame(frame);
  }

  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', readScroll, { passive: true });
  readScroll();
  current = target;             // no opening lurch on a restored scroll
  if (scene) scene.setProgress(current);

  if (reduced) {
    /* No loop. The rail still has to track, so update it on scroll only. */
    window.addEventListener('scroll', function () {
      if (railPig) railPig.style.top = (target * 100).toFixed(2) + '%';
      if (railPct) railPct.textContent = String(Math.round(target * 100)).padStart(2, '0');
      if (scene) scene.setProgress(target);
    }, { passive: true });
  } else {
    window.requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------- reveals ---- */

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    Array.prototype.forEach.call(doc.querySelectorAll('.reveal'), function (el) {
      io.observe(el);
    });
  } else {
    Array.prototype.forEach.call(doc.querySelectorAll('.reveal'), function (el) {
      el.classList.add('in');
    });
  }

  /* -------------------------------------------------------- counts ---- */

  if ('IntersectionObserver' in window) {
    var counters = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        counters.unobserve(e.target);
        var el = e.target;
        var to = parseFloat(el.getAttribute('data-count')) || 0;
        var dp = parseInt(el.getAttribute('data-decimals') || '0', 10);
        if (reduced) {
          el.textContent = dp ? to.toFixed(dp) : Math.round(to).toLocaleString();
          return;
        }
        var t0 = performance.now(), dur = 1300;
        (function step(now) {
          var k = Math.min(1, (now - t0) / dur);
          // easeOutExpo: quick, then settling, like an instrument at rest.
          var eased = k === 1 ? 1 : 1 - Math.pow(2, -10 * k);
          var v = to * eased;
          el.textContent = dp ? v.toFixed(dp) : Math.round(v).toLocaleString();
          if (k < 1) window.requestAnimationFrame(step);
        })(performance.now());
      });
    }, { threshold: 0.45 });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-count]'), function (el) {
      counters.observe(el);
    });
  }

  /* -------------------------------------------- sticky stage sequence -- */
  /* The panel on the left holds still and redraws as each stage on the
     right crosses the middle of the viewport. The order of the pipeline is
     carried by the scrolling itself rather than by five cards in a row. */

  var stages = doc.querySelectorAll('.stage');
  var figs = doc.querySelectorAll('.stage-fig');
  var stageN = doc.getElementById('stage-n');
  var stageTitle = doc.getElementById('stage-title');
  var stageFill = doc.getElementById('stage-fill');
  var activeStage = -1;

  function setStage(n) {
    if (n === activeStage) return;
    activeStage = n;

    Array.prototype.forEach.call(stages, function (el) {
      el.classList.toggle('on', parseInt(el.getAttribute('data-stage'), 10) === n);
    });
    Array.prototype.forEach.call(figs, function (el) {
      el.classList.toggle('is-on', parseInt(el.getAttribute('data-stage'), 10) === n);
    });

    var src = doc.querySelector('.stage[data-stage="' + n + '"] h3');
    if (stageN) stageN.textContent = String(n).padStart(2, '0');
    if (stageTitle && src) stageTitle.textContent = src.textContent;
    if (stageFill) stageFill.style.width = (n / stages.length * 100) + '%';
  }

  if (stages.length) {
    if ('IntersectionObserver' in window) {
      /* A band across the middle of the viewport. A stage is active while it
         is the one being read, not merely while it is on screen — without
         the band, two stages are "visible" for most of the scroll and the
         panel flickers between them. */
      var stageIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            setStage(parseInt(e.target.getAttribute('data-stage'), 10));
          }
        });
      }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
      Array.prototype.forEach.call(stages, function (el) { stageIo.observe(el); });
    }
    setStage(1);
  }

  /* ------------------------------------------------ section dot nav ---- */

  var dots = doc.querySelectorAll('.dots a');
  if (dots.length && 'IntersectionObserver' in window) {
    var sectionIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = '#' + e.target.id;
        Array.prototype.forEach.call(dots, function (d) {
          d.classList.toggle('on', d.getAttribute('href') === id);
        });
      });
    }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 });
    Array.prototype.forEach.call(doc.querySelectorAll('main > section'), function (s) {
      if (s.id) sectionIo.observe(s);
    });
  }
})();
