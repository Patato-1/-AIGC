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
      } else if (isWan3(item)) {
        // 速创 Wan3.0 走自己的通道：密钥在后端、参考图要先传成公网 URL、
        // 返回结构也和 Grsai 不一样。细节看 runWan3。
        await runWan3(item, job, itemId);
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
     速创 Wan3.0（走本地后端转发）
     --------------------------------------------------------------------------
     它和 Grsai 的差别挺大，所以单独一条通道：

       1. 密钥在后端（config.wuyinkeji.local.py）—— 浏览器看不到，安全
       2. images 只收【公网 URL】，不收 base64
          → 所以生成前要把连进来的参考图自动上传到自己的 OSS
       3. 任务 id 在 data.id（Grsai 在顶层）
       4. 返回里没有 progress，只有"跑完了没"
       5. duration / generate_audio 必须传字符串

     参考图的 OSS 地址会记在素材卡的 remoteUrl 上，同一张图只传一次。
     ========================================================================== */

  function isWan3(item) {
    return !!(item && item.model === 'wan3.0');
  }

  function backendBase() {
    // 统一由 api.js 推导（它知道 BACKEND_URL 和同源的情况），这里不再自己拼
    return (FC.api && FC.api.backendBase) ? FC.api.backendBase() : '';
  }

  /**
   * 把连进这张卡的参考图，逐张变成公网 URL。
   * - 已经传过的（素材卡上有 remoteUrl）直接用，不重复传
   * - 没传过的走「上传到云端」，传完把地址记回素材卡
   * @returns {Promise<string[]>} 公网地址列表
   */
  async function collectRefUrls(item) {
    var list = parseRefs(item);
    var urls = [];
    var need = 0;
    for (var i = 0; i < list.length; i++) {
      if (!Store.get(list[i].assetId).remoteUrl) need++;
    }
    if (need) FC.ui.toast('正在上传 ' + need + ' 张参考图…', 'i-cloud');

    for (var k = 0; k < list.length && urls.length < 10; k++) {
      var r = list[k];
      var asset = Store.get(r.assetId);
      if (!asset) continue;

      // 已经传过的直接用
      if (asset.remoteUrl && FC.ui.isOssUrl(asset.remoteUrl)) {
        urls.push(asset.remoteUrl);
        continue;
      }

      var blob = (FC.assets && FC.assets.blobOf(asset.id)) ||
                 (FC.assets && FC.assets.get ? await FC.assets.get(asset.id) : null);
      if (!blob) {
        // 远程图（比如从历史放回画布的）直接拿它的地址
        if (asset.remoteUrl) { urls.push(asset.remoteUrl); continue; }
        if (asset.src && /^https?:/.test(asset.src)) { urls.push(asset.src); continue; }
        continue;
      }

      var url = await FC.ui.uploadToCloud(URL.createObjectURL(blob), asset.name || '参考图');
      if (!url) continue;
      // 记回素材卡，下次不用再传
      Store.update(asset.id, { remoteUrl: url }, { commit: false });
      urls.push(url);
    }
    return urls;
  }

  async function runWan3(item, job, itemId) {
    var base = backendBase();
    if (!base) {
      throw new Error('没配上传服务地址（config.local.js 的 UPLOAD_URL），无法调用后端');
    }

    var size = resultSize(item);

    // 1) 参考图 → 公网 URL
    var urls = await collectRefUrls(item);
    if (job.cancelled) return;

    // 2) 提交（后端加密钥转发）
    setProgress(itemId, 3);
    var body = {
      prompt: item.prompt,
      images: urls,                            // 数组，后端会拼成逗号串
      ratio: item.ratio,
      duration: String(parseInt(item.duration, 10) || 5),   // 必须字符串
      generate_audio: 'false'                  // 先不生成音频（省时间）
    };
    var res = await fetch(base + '/api/wy/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var out = null;
    try { out = await res.json(); } catch (e) { out = null; }
    if (!out || !out.ok) {
      throw new Error((out && out.error) || ('提交失败 HTTP ' + res.status));
    }
    job.taskId = out.id;
    setProgress(itemId, 8);

    // 3) 轮询。它不给进度百分比，所以进度条走个假的"心跳"表现还在跑。
    var STALL_MS = 8 * 60 * 1000;
    var MAX_MS = 30 * 60 * 1000;
    var t0 = Date.now();
    var lastChange = Date.now();
    var fake = 8;

    while (!job.cancelled) {
      await sleep(6000);
      if (job.cancelled) break;

      var r2 = await fetch(base + '/api/wy/detail?id=' + encodeURIComponent(job.taskId));
      var st = null;
      try { st = await r2.json(); } catch (e) { st = null; }
      if (!st) continue;

      // 心跳：慢慢往上爬，但不超过 95%，免得看起来"已经完成"
      fake = Math.min(95, fake + 3);
      setProgress(itemId, fake);

      if (st.status === 'succeeded' && st.url) {
        Store.update(itemId, {
          result: {
            kind: 'video',
            src: st.url,
            w: size.w,
            h: size.h,
            createdAt: Date.now(),
            demo: false
          }
        });
        if (FC.history) {
          FC.history.add({
            kind: 'video',
            prompt: item.prompt || '',
            model: item.model,
            ratio: item.ratio,
            duration: item.duration,
            refs: (await Promise.resolve(parseRefs(item))).map(function (x) {
              return { handle: x.handle, name: x.name, role: x.role };
            }),
            url: st.url,
            taskId: job.taskId,
            cardId: itemId,
            w: size.w,
            h: size.h,
            demo: false
          });
          if (FC.ui.refreshHistoryBadge) FC.ui.refreshHistoryBadge();
        }
        FC.ui.toast('生成完成', 'i-check');
        archiveResult(itemId, st.url, item.prompt, true);
        return;
      }

      if (st.status === 'failed') {
        throw new Error(st.error || '生成失败');
      }

      if (Date.now() - lastChange > STALL_MS) {
        throw new Error('任务卡住了：超过 ' + Math.round(STALL_MS / 60000) + ' 分钟没有变化');
      }
      if (Date.now() - t0 > MAX_MS) {
        throw new Error('任务超时（超过 ' + Math.round(MAX_MS / 60000) + ' 分钟）');
      }
    }
  }

  /* ==========================================================================
     真实后端：轮询任务
     （把 CONFIG.USE_MOCK 改成 false 就会走这里）
     ========================================================================== */
  async function runRemote(item, job, itemId) {
    var size = resultSize(item);

    // 参考图：来自连进这张卡的素材（按连线顺序，第一条当主参考）
    // 图片真身在 IndexedDB，这里取出 Blob 再转成 dataURL 发给后端。
    // 接中转站时如果对方不收 base64，把这里换成 assets 上传拿 URL 即可（改动只在这几行）。
    var list = parseRefs(item);            // 已经按 @ 和角色筛过
    var refImages = [];
    for (var k = 0; k < list.length; k++) {
      var r = list[k];
      var blob = (FC.assets && FC.assets.blobOf(r.assetId)) || null;
      var data = null;
      if (blob) {
        data = await FC.assets.blobToDataURL(blob);
      } else {
        var src = Store.get(r.assetId);
        if (src && src.src) data = src.src;    // 旧数据兜底
      }
      if (data) refImages.push({ id: r.assetId, handle: r.handle, name: r.name, role: r.role, data: data });
      if (refImages.length >= 8) break;      // 别一次塞太多
    }
    var refImage = refImages.length ? refImages[0].data : null;

    var task = await FC.genApi.submit({
      kind: item.kind === 'video-gen' ? 'video' : 'image',
      prompt: item.prompt,
      model: item.model,
      ratio: item.ratio,
      style: item.style,
      duration: item.duration,
      resolution: item.resolution,
      width: size.w,
      height: size.h,
      // 参考图 + 各自角色。api.js 负责决定怎么发（base64 还是上传后的 url）。
      refs: refImages.map(function (r) {
        return { handle: r.handle, name: r.name, role: r.role, image: r.data };
      })
    });
    job.taskId = task.taskId;

    // 中转站偶尔会有任务卡死（实测遇到过一个一直停在 progress:2 十几分钟的）。
    // 所以要有兜底：进度长时间不动 或 总时长超限，就报错退出，别让进度条一直转。
    // 实测：gpt-image-2.5 可能要十几分钟，而且中间进度会长时间不动（一直显示 2%），
    // 但最后是成功的。所以这两个值不能太紧，否则会把正常任务误判成卡死。
    var STALL_MS = 5 * 60 * 1000;     // 进度 5 分钟没变化 → 认为卡死
    var MAX_MS = 30 * 60 * 1000;      // 总时长上限
    var t0 = Date.now();
    var lastPct = -1;
    var lastChange = Date.now();

    var done = false;
    while (!done && !job.cancelled) {
      await sleep(800);
      if (job.cancelled) break;

      var st = await FC.genApi.poll(task.taskId);
      if (job.cancelled) break;

      if (st.progress !== undefined) {
        if (st.progress !== lastPct) { lastPct = st.progress; lastChange = Date.now(); }
        setProgress(itemId, st.progress);
      }

      if (Date.now() - lastChange > STALL_MS) {
        throw new Error('任务卡住了：进度停在 ' + lastPct + '% 超过 ' + Math.round(STALL_MS / 60000) + ' 分钟。' +
          '中转站那边可能排队拥堵或该模型有问题，换个模型或稍后重试。');
      }
      if (Date.now() - t0 > MAX_MS) {
        throw new Error('任务超时（超过 ' + Math.round(MAX_MS / 60000) + ' 分钟还没完成）');
      }

      // 中转站的状态：running / succeeded / violation / failed
      if (st.status === 'succeeded') {
        done = true;
        if (!st.url) throw new Error('生成成功但没拿到图片地址');
        Store.update(itemId, {
          result: {
            kind: item.kind === 'video-gen' ? 'video' : 'image',
            src: st.url,
            seed: st.seed,
            w: size.w,
            h: size.h,
            createdAt: Date.now(),
            demo: false
          }
        });
        // 记进生成历史：只存元数据 + 云端地址，不占本地空间。
        // 卡片以后被删掉，历史里照样找得到。
        if (FC.history) {
          FC.history.add({
            kind: item.kind === 'video-gen' ? 'video' : 'image',
            prompt: item.prompt || '',
            model: item.model,
            ratio: item.ratio,
            style: item.style,
            quality: item.kind === 'video-gen' ? undefined : 'auto',
            duration: item.duration,
            resolution: item.resolution,
            refs: refImages.map(function (r) {
              return { handle: r.handle, name: r.name, role: r.role };   // 只记名字，不记图
            }),
            url: st.url,
            taskId: task.taskId,
            cardId: itemId,
            w: size.w,
            h: size.h,
            demo: false
          });
          if (FC.ui.refreshHistoryBadge) FC.ui.refreshHistoryBadge();
        }

        FC.ui.toast('生成完成', 'i-check');

        // 后台转存到你自己的 OSS。
        // 中转站的图床是临时的（实测约 4 小时后 404），不搬走的话这张图迟早会失效。
        // 特意不 await —— 卡片已经能看了，转存慢不该拖住你。
        archiveResult(itemId, st.url, item.prompt, item.kind === 'video-gen');
      } else if (st.status === 'failed') {
        throw new Error(st.error || '生成失败');
      } else if (st.status === 'violation') {
        throw new Error(st.error || '内容违规，被拒绝了');
      }
    }
  }

  /**
   * 生成结果转存到自己的 OSS，然后把卡片和历史里的地址都换成 OSS 的。
   *
   * 为什么要有这一步：中转站的图床会过期（实测约 4 小时后 404），
   * 不搬走的话画布上的图过一天就集体失效了。
   *
   * 失败不影响卡片 —— 结果还在中转站，只是几小时后可能会失效，
   * 所以失败时给个明确提示，让你知道该手动「上传到云端」。
   */
  async function archiveResult(itemId, relayUrl, prompt, isVideo) {
    if (!FC.ui || !FC.ui.archiveToCloud) return;
    if (!relayUrl || /^(blob:|data:)/i.test(relayUrl)) return;

    var ossUrl = null;
    try {
      ossUrl = await FC.ui.archiveToCloud(relayUrl, prompt || '生成结果');
    } catch (e) {
      ossUrl = null;
    }

    // 拿不到 OSS 地址：说明没跑上传服务、OSS 没配、或者抓取失败了。
    // 不发 toast 刷屏，只在控制台留一句，卡片上会有"仅中转站"的角标提示。
    if (!ossUrl) {
      console.warn('[archive] 没能转存，这张结果仍在中转站，可能会过期：' + relayUrl);
      var cur = Store.get(itemId);
      if (cur && cur.result && cur.result.src === relayUrl) {
        Store.update(itemId, {
          result: Object.assign({}, cur.result, { archiveFailed: true })
        });
      }
      return;
    }

    // 转存成功 —— 但期间用户可能已经重新生成了，地址变了就别覆盖
    var now = Store.get(itemId);
    if (!now || !now.result || now.result.src !== relayUrl) return;

    Store.update(itemId, {
      result: Object.assign({}, now.result, {
        src: ossUrl,              // 换成永久地址
        origin: relayUrl,         // 记着原始地址，方便排查
        archived: true,
        archiveFailed: false
      })
    });

    // 历史里那条也要换，否则从历史「放回画布」拿到的还是会过期的地址
    if (FC.history && FC.history.patchLatest) {
      FC.history.patchLatest(itemId, { url: ossUrl, origin: relayUrl, archived: true });
    }

    FC.ui.toast('已转存到你的云端', 'i-cloud');
  }

  /** 把这张卡的输入拼成一个稳定 key：@ 了哪些、什么角色，都会影响结果 */
  function refKey(item) {
    return parseRefs(item).map(function (r) {
      return r.assetId + ':' + r.role + ':' + (r.used ? '1' : '0');
    }).join('|');
  }

  /**
   * 解析提示词里的 @短名，跟连进来的图对上。
   * - @ 了的：标记 used=true，带上角色
   * - 没 @ 的：全部当作「参考」一起带上（保持老行为，不会因为忘了 @ 就不传图）
   */
  function parseRefs(item) {
    var refs = Store.refsOf(item.id);
    var prompt = String(item.prompt || '');
    var mentioned = {};

    refs.forEach(function (r) {
      // 匹配 @名字，后面不能紧跟字母数字（避免 @图1 命中 @图10）
      var re = new RegExp('@' + r.handle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '(?![\\\\w\\\\u4e00-\\\\u9fff])');
      if (re.test(prompt)) { r.used = true; mentioned[r.assetId] = true; }
    });

    var anyMentioned = Object.keys(mentioned).length > 0;
    return refs.filter(function (r) {
      return anyMentioned ? r.used : true;   // 一个都没 @ 时，全部当参考
    });
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
    resultSize: resultSize,
    parseRefs: parseRefs       // 暴露出来便于自测：提示词里的 @ 怎么映射成参考图
  };
})(window.FC);