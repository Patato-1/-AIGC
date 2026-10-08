/* ==========================================================================
   generate.js — 生成流程
   --------------------------------------------------------------------------
   现在（USE_MOCK = true）：
     提交 → 本地模拟进度 → 用 art.js 按 seed 画一张确定性占位图 → 写入 result
   以后接后端：
     只要把 runMock() 换成 runRemote()，进度与结果都来自 GenAPI，
     上层的取消、状态、错误处理完全不用改（见下方 runRemote）。
   ========================================================================== */
(function (FC) {
  'use strict';

  var Store = FC.Store;
  var R = FC.render;

  var jobs = {};          // itemId -> { cancelled, taskId, timer }

  /* ---------- 进度写入 ---------- */
  function setProgress(id, pct) {
    Store.runtime.progress[id] = { pct: Math.max(0, Math.min(100, Math.round(pct))) };
    R.requestItems();
  }
  function clearProgress(id) {
    delete Store.runtime.progress[id];
    R.requestItems();
  }
  function isBusy(id) { return !!Store.runtime.progress[id]; }

  /* ---------- 结果尺寸 ---------- */
  function resultSize(item) {
    var longEdge = item.kind === 'video-gen' ? 960 : 900;
    return FC.art.sizeFor(item.ratio, longEdge);
  }

  /* ==========================================================================
     对外
     ========================================================================== */
  async function start(itemId) {
    var item = Store.get(itemId);
    if (!item || item.kind === 'asset') return;

    // 正在生成 → 视为「取消」
    if (isBusy(itemId)) { cancel(itemId); return; }

    if (!String(item.prompt || '').trim()) {
      FC.ui.toast('先写一句提示词吧', 'i-sparkle');
      var el = R.elOf(itemId);
      var ta = el && el.querySelector('[data-k="prompt"]');
      if (ta) ta.focus();
      return;
    }

    var job = { cancelled: false, taskId: null, timer: null };
    jobs[itemId] = job;
    setProgress(itemId, 0);

    try {
      if (FC.genApi.config.USE_MOCK) {
        await runMock(item, job, itemId);
      } else {
        await runRemote(item, job, itemId);
      }
    } catch (err) {
      if (!job.cancelled) {
        clearProgress(itemId);
        FC.ui.toast('生成失败：' + (err.message || err), 'i-close');
        console.error('[generate]', err);
      }
    } finally {
      delete jobs[itemId];
      if (!job.cancelled) clearProgress(itemId);
    }
  }

  function cancel(itemId) {
    var job = jobs[itemId];
    if (job) {
      job.cancelled = true;
      clearTimeout(job.timer);
      if (job.taskId) { try { FC.genApi.cancel(job.taskId); } catch (e) { /* ignore */ } }
      delete jobs[itemId];
    }
    clearProgress(itemId);
    FC.ui.toast('已取消生成');
  }

  function cancelAll() {
    Object.keys(jobs).forEach(function (id) { cancel(id); });
  }

  /* ==========================================================================
     Mock：本地模拟
     ========================================================================== */
  function runMock(item, job, itemId) {
    return new Promise(function (resolve) {
      var size = resultSize(item);
      // 视频慢一些，生图快一些，让节奏更真实
      var steps = item.kind === 'video-gen' ? 34 : 20;
      var i = 0;
      // 按「步数」推进，不依赖性能时钟：后台标签页也能跑完

      function tick() {
        if (job.cancelled) { resolve(); return; }
        i += 1;
        // 前 12% 很快，之后变慢（像真实排队 + 推理）
        var t = Math.min(1, i / steps);
        var eased = t < 0.12 ? t / 0.12 * 0.30 : 0.30 + Math.pow((t - 0.12) / 0.88, 0.85) * 0.70;
        setProgress(itemId, eased * 100);
        if (t < 1) {
          job.timer = setTimeout(tick, 60);
        } else {
          finishMock(item, itemId, size);
          resolve();
        }
      }
      job.timer = setTimeout(tick, 60);
    });
  }

  function finishMock(item, itemId, size) {
    var seed = FC.art.seedFrom([
      item.prompt, item.model, item.ratio, item.style,
      item.duration || '', refKey(item),
      Date.now().toString(36)
    ]);
    Store.update(itemId, {
      result: {
        kind: item.kind === 'video-gen' ? 'video' : 'image',
        seed: seed,
        w: size.w,
        h: size.h,
        createdAt: Date.now(),
        demo: true                 // 接后端后置为 false
      }
    });
    FC.ui.toast(item.kind === 'video-gen' ? '视频生成完成（演示结果）' : '图片生成完成（演示结果）', 'i-check');
  }

  /* ==========================================================================
     真实后端：轮询任务
     （把 CONFIG.USE_MOCK 改成 false 就会走这里）
     ========================================================================== */
  async function runRemote(item, job, itemId) {
    var size = resultSize(item);

    // 参考图：来自连进这张卡的素材（多条时取第一条素材）
    var refImage = null;
    var inc = Store.doc.links.filter(function (l) { return l.to === itemId; });
    for (var k = 0; k < inc.length; k++) {
      var src = Store.get(inc[k].from);
      if (src && src.kind === 'asset' && src.src) { refImage = src.src; break; }
    }

    var task = await FC.genApi.submit({
      kind: item.kind === 'video-gen' ? 'video' : 'image',
      prompt: item.prompt,
      model: item.model,
      ratio: item.ratio,
      style: item.style,
      duration: item.duration,
      width: size.w,
      height: size.h,
      refImage: refImage
    });
    job.taskId = task.taskId;

    var done = false;
    while (!done && !job.cancelled) {
      await sleep(800);
      if (job.cancelled) break;

      var st = await FC.genApi.poll(task.taskId);
      if (job.cancelled) break;

      if (st.progress !== undefined) setProgress(itemId, st.progress);

      if (st.status === 'done') {
        done = true;
        Store.update(itemId, {
          result: {
            kind: item.kind === 'video-gen' ? 'video' : 'image',
            src: st.url,
            seed: st.seed,
            w: st.width || size.w,
            h: st.height || size.h,
            createdAt: Date.now(),
            demo: false
          }
        });
        FC.ui.toast('生成完成', 'i-check');
      } else if (st.status === 'error') {
        throw new Error(st.error || '生成失败');
      }
    }
  }

  /** 把这张卡的输入来源拼成一个稳定 key，输入变了结果也应该变 */
  function refKey(item) {
    return Store.doc.links.filter(function (l) { return l.to === item.id; })
      .map(function (l) { return l.from; }).sort().join('|');
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ========================================================================== */
  FC.generate = {
    start: start,
    cancel: cancel,
    cancelAll: cancelAll,
    isBusy: isBusy,
    resultSize: resultSize
  };
})(window.FC);