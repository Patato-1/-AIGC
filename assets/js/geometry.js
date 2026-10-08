/* ==========================================================================
   geometry.js — 坐标变换与矩形工具
   屏幕坐标 = 世界坐标 * k + (x, y)
   ========================================================================== */
(function (FC) {
  'use strict';

  function toScreen(wx, wy, view) {
    return { x: wx * view.k + view.x, y: wy * view.k + view.y };
  }

  function toWorld(sx, sy, view) {
    return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
  }

  function rectsIntersect(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

  /** 点是否落在矩形内 */
  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  FC.geo = {
    toScreen: toScreen,
    toWorld: toWorld,
    rectsIntersect: rectsIntersect,
    clamp: clamp,
    dist: dist,
    pointInRect: pointInRect
  };
})(window.FC);