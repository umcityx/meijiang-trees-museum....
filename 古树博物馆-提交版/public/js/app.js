/**
 * 古树博物馆 - 主应用逻辑
 *
 * 架构分层：
 *   - Utils:     工具函数（DOM 查询、HTML 转义、元素创建）
 *   - DOMCache:  全局 DOM 引用缓存（避免重复查询）
 *   - Renderer:  视图渲染（卡片、修复方法、统计）
 *   - Modal:     详情弹窗
 *   - MapMgr:    地图管理（Leaflet + 高德，切换/重置/标记）
 *   - App:       主入口（事件绑定、初始化）
 */
(function () {
  'use strict';

  /* ======================== Utils ======================== */

  /** HTML 特殊字符转义，防止 XSS */
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** querySelector 简写 */
  function $(selector, parent) {
    return (parent || document).querySelector(selector);
  }

  /** querySelectorAll 转 Array */
  function $all(selector, parent) {
    return Array.from((parent || document).querySelectorAll(selector));
  }

  /** getElementById 简写 */
  function byId(id) {
    return document.getElementById(id);
  }

  /** 安全地设置 innerHTML（先转义所有插值数据） */
  function setHTML(el, html) {
    el.innerHTML = html;
  }

  /** 截断文本到指定长度 */
  function truncate(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '……' : text;
  }

  /** 安全 JSON-LD 解析（容错） */
  function safeParse(fn) {
    try {
      return fn();
    } catch (err) {
      console.error('[古树博物馆] 运行时错误:', err);
      return null;
    }
  }

  /* ======================== DOMCache ======================== */

  const DOM = {
    treesContainer:    null,
    restorationMethods:null,
    treeCount:         null,
    speciesCount:      null,
    oldestTree:        null,
    mapContainer:      null,
    mobileMenuBtn:     null,
    mainNav:           null,
    satelliteMapBtn:   null,
    fallbackMapBtn:    null,
    resetViewBtn:      null,
    virtualTourBtn:    null,
    taxonomySummary:   null,
  };

  function initDOMCache() {
    DOM.treesContainer     = byId('treesContainer');
    DOM.restorationMethods = byId('restorationMethods');
    DOM.treeCount          = byId('treeCount');
    DOM.speciesCount       = byId('speciesCount');
    DOM.oldestTree         = byId('oldestTree');
    DOM.mapContainer       = byId('tree-map');
    DOM.mobileMenuBtn      = byId('mobileMenuBtn');
    DOM.mainNav            = byId('mainNav');
    DOM.satelliteMapBtn    = byId('satelliteMapBtn');
    DOM.fallbackMapBtn     = byId('fallbackMapBtn');
    DOM.resetViewBtn       = byId('resetViewBtn');
    DOM.virtualTourBtn     = byId('virtualTourBtn');
    DOM.taxonomySummary    = byId('taxonomySummary');
    DOM.treeSearchInput    = byId('treeSearchInput');
    DOM.treeSearchClear    = byId('treeSearchClear');
  }

  /* ======================== Renderer ======================== */

  const Renderer = {
    _pageSize: 12,
    _currentPage: 1,
    _viewMode: 'all', // 'all' | 'family' | 'genus'
    _searchQuery: '',

    /** 设置视图模式并重新渲染 */
    setViewMode(mode) {
      this._viewMode = mode;
      this._currentPage = 1;
      this.render();
    },

    /** 设置搜索关键字（trim 后的小写字符串），并重新渲染 */
    setSearch(query) {
      this._searchQuery = (query || '').trim().toLowerCase();
      this._currentPage = 1; // 搜索后重置分页
      this.render();
    },

    /** 取得当前搜索关键字（用于显示在分组标题等） */
    getSearchQuery() {
      return this._searchQuery;
    },

    /** 判断是否处于搜索状态 */
    isSearching() {
      return this._searchQuery.length > 0;
    },

    /** 统一过滤：按 name/otherName/latinName/family/genus/location 模糊匹配（小写） */
    _filterTrees(trees) {
      const q = this._searchQuery;
      if (!q) return trees;
      return trees.filter((t) => {
        const hay = [
          t.name, t.otherName, t.latinName, t.family, t.genus, t.location
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    },

    /** 是否已使用用户提供的实拍图（本地 images/ 路径） */
    _hasLocalImage(tree) {
      return typeof tree.image === 'string' && tree.image.indexOf('images/') === 0;
    },

    /** 稳定排序：已有实拍图的古树排前面，其余保持原 id 顺序 */
    _sortLocalFirst(trees) {
      // Array.sort 自 ES2019 起稳定；本地图(true=1) 减 其他(false=0) = 正值则 a 排后
      return trees.slice().sort((a, b) => {
        const ha = this._hasLocalImage(a) ? 1 : 0;
        const hb = this._hasLocalImage(b) ? 1 : 0;
        return hb - ha;
      });
    },

    /** 统一渲染入口，根据 _viewMode 分发 */
    render() {
      if (this._viewMode === 'family' || this._viewMode === 'genus') {
        this._renderGrouped(this._viewMode);
      } else {
        this._renderFlat();
      }
      this.updateTaxonomySummary();
      this.updateSearchHint();
    },

    /** 渲染单棵古树卡片（两种模式共用） */
    _renderTreeCard(tree) {
      const e = escapeHtml;
      return `
        <article class="tree-card" data-tree-id="${tree.id}">
          <img src="${e(tree.image)}"
               alt="${e(tree.name)}的古树实拍"
               class="tree-img js-viewable"
               data-tree-id="${tree.id}"
               data-index="0"
               loading="lazy"
               onerror="this.src='${AppData.FALLBACK_IMAGE}'">
          <div class="tree-info">
            <div class="tree-badges">
              <span class="tree-badge tree-badge--family">${e(tree.family)}</span>
              <span class="tree-badge tree-badge--genus">${e(tree.genus)}</span>
            </div>
            <h3 class="tree-name">${e(tree.name)}</h3>
            <div class="tree-age">树龄：${e(tree.age)} | 保护措施：${e(tree.maintenance)}</div>
            <div class="tree-desc">${e(truncate(tree.description, 100))}</div>
            <a href="#" class="tree-link" data-tree-id="${tree.id}" role="button">查看更多 →</a>
          </div>
        </article>`;
    },

    /** 平铺模式渲染（分页加载） */
    _renderFlat() {
      if (!DOM.treesContainer) return;

      // 先按"有实拍图优先"排序，再按搜索过滤
      const allTrees = this._sortLocalFirst(AppData.treesData);
      const matchedTrees = this._filterTrees(allTrees);

      // 搜索时一次性显示全部匹配；非搜索时按页加载
      const showAll = this.isSearching();
      const endIndex = showAll ? matchedTrees.length : this._currentPage * this._pageSize;
      const visibleTrees = matchedTrees.slice(0, endIndex);

      if (matchedTrees.length === 0) {
        setHTML(DOM.treesContainer, `<div class="trees-empty">未找到匹配 "${e(this._searchQuery)}" 的古树，请换个关键词试试。</div>`);
        return;
      }

      const cardsHTML = visibleTrees
        .map((t) => this._renderTreeCard(t))
        .join('');

      const hasMore = !showAll && endIndex < matchedTrees.length;
      const loadMoreHTML = hasMore
        ? `<div class="load-more-wrapper"><button class="load-more-btn" id="loadMoreBtn">加载更多（${matchedTrees.length - endIndex}/${matchedTrees.length}）</button></div>`
        : '';

      // 用 trees-grid 包裹卡片，保持 grid 布局
      setHTML(DOM.treesContainer, `<div class="trees-grid">${cardsHTML}</div>${loadMoreHTML}`);
    },

    /** 分组模式渲染（按科或属折叠展示） */
    _renderGrouped(groupKey) {
      if (!DOM.treesContainer) return;

      const allTrees = this._sortLocalFirst(AppData.treesData);
      const matchedTrees = this._filterTrees(allTrees);

      if (matchedTrees.length === 0) {
        setHTML(DOM.treesContainer, `<div class="trees-empty">未找到匹配 "${e(this._searchQuery)}" 的古树，请换个关键词试试。</div>`);
        return;
      }

      // 按科或属分组
      const groups = {};
      matchedTrees.forEach((tree) => {
        const key = tree[groupKey] || '未分类';
        if (!groups[key]) groups[key] = [];
        groups[key].push(tree);
      });

      // 按棵数降序排列
      const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

      const groupLabel = groupKey === 'family' ? '科' : '属';

      // 搜索时全部展开，否则仅展开第一组
      const searchOpen = this.isSearching();

      const html = sorted.map(([groupName, trees], idx) => {
        const expanded = searchOpen || idx === 0;
        // 组内也按"有实拍图优先"再排一次（外层排序进入该组时已按本地图优先，但跨组对比后顺序被保留）
        const ordered = this._sortLocalFirst(trees);
        const cards = ordered.map((t) => this._renderTreeCard(t)).join('');
        return `
          <div class="taxonomy-group ${expanded ? 'expanded' : ''}" data-group="${escapeHtml(groupName)}">
            <div class="taxonomy-group__header" role="button" tabindex="0" aria-expanded="${expanded}">
              <i class="fas fa-chevron-right taxonomy-group__arrow"></i>
              <span class="taxonomy-group__name">${escapeHtml(groupName)}</span>
              <span class="taxonomy-group__label">${groupLabel}</span>
              <span class="taxonomy-group__count">${trees.length} 棵</span>
            </div>
            <div class="taxonomy-group__body">
              <div class="trees-grid">${cards}</div>
            </div>
          </div>`;
      }).join('');

      setHTML(DOM.treesContainer, html);
    },

    /** 更新分类摘要 */
    updateTaxonomySummary() {
      if (!DOM.taxonomySummary) return;
      const trees = this._filterTrees(AppData.treesData);
      const families = new Set(trees.map((t) => t.family));
      const genera = new Set(trees.map((t) => t.genus));
      if (this.isSearching()) {
        DOM.taxonomySummary.textContent = `已筛选 ${trees.length} 棵 · ${families.size} 科 · ${genera.size} 属`;
      } else {
        DOM.taxonomySummary.textContent = `${families.size} 科 · ${genera.size} 属 · ${trees.length} 棵`;
      }
    },

    /** 更新搜索结果提示（控制清除按钮的显隐） */
    updateSearchHint() {
      if (!DOM.treeSearchClear) return;
      DOM.treeSearchClear.hidden = !this.isSearching();
    },

    /** 渲染修复方法卡片 */
    renderRestorationMethods() {
      if (!DOM.restorationMethods) return;

      const cardsHTML = AppData.restorationMethods.map((method) => {
        const e = escapeHtml;
        let examplesHTML = '';
        if (method.examples && method.examples.length) {
          const items = method.examples.map((ex) => `
            <div class="example-item">
              <div class="example-tree">${e(ex.tree)}</div>
              <div>${e(ex.measure)}</div>
            </div>`).join('');
          examplesHTML = `<div class="method-examples"><h4>应用实例：</h4>${items}</div>`;
        }
        return `
          <article class="method-card">
            <div class="method-icon"><i class="${e(method.icon)}"></i></div>
            <h3 class="method-title">${e(method.title)}</h3>
            <p>${e(method.description)}</p>
            ${examplesHTML}
          </article>`;
      }).join('');

      setHTML(DOM.restorationMethods, cardsHTML);
    },

    /** 更新统计数字 */
    updateStats() {
      const trees = AppData.treesData;

      // 古树总数
      DOM.treeCount.textContent = trees.length;

      // 树种类数（按名称去重，去掉括号备注）
      const species = new Set(trees.map((t) => t.name.split('（')[0]));
      DOM.speciesCount.textContent = species.size;

      // 最古老树龄
      const maxAge = trees.reduce((max, t) => Math.max(max, t.estimateAge || 0), 0);
      DOM.oldestTree.textContent = maxAge + ' 年';
    },
  };

  /* ======================== Modal ======================== */

  const Modal = {
    _current: null,

    /** 根据 ID 查找古树数据 */
    _findTree(id) {
      return AppData.treesData.find((t) => t.id === id) || null;
    },

    /** 显示详情弹窗 */
    show(id) {
      const tree = this._findTree(id);
      if (!tree) return;

      // 若已有弹窗，先关闭
      this.close();

      const e = escapeHtml;
      const story = e(tree.description).replace(/\n/g, '<br>');
      const gallery = (tree.gallery && tree.gallery.length) ? tree.gallery : [tree.image];

      // 古树小导游：简介页不再展示立绘和 3D，改为地图上的固定立绘 + 点击古树时弹字幕

      const tagsHTML = `
        <div class="tree-modal__tag"><strong>树龄：</strong>${e(tree.age)}</div>
        <div class="tree-modal__tag"><strong>保护等级：</strong>${e(tree.level)}</div>
        <div class="tree-modal__tag"><strong>保护措施：</strong>${e(tree.maintenance)}</div>`;

      const basicInfoHTML = `
        <p><strong>别名：</strong>${e(tree.otherName)}</p>
        <p><strong>拉丁名：</strong>${e(tree.latinName)}</p>
        <p><strong>科属：</strong>${e(tree.family)} ${e(tree.genus)}</p>
        <p><strong>树高：</strong>${e(tree.height)}</p>
        <p><strong>胸径：</strong>${e(tree.dbh)}</p>
        <p><strong>冠幅：</strong>${e(tree.canopy)}</p>`;

      const protectionHTML = `
        <p><strong>管理单位：</strong>${e(tree.manageUnit)}</p>
        <p><strong>保护措施：</strong>${e(tree.protectionMeasures)}</p>
        <p><strong>具体位置：</strong>${e(tree.location)}</p>`;

      const modal = document.createElement('div');
      modal.className = 'tree-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'modal-title');

      modal.innerHTML = `
        <div class="tree-modal__dialog">
          <div class="tree-modal__hero">
            <img src="${e(gallery[0])}"
                 alt="${e(tree.name)}"
                 class="js-viewable js-modal-hero"
                 data-tree-id="${tree.id}"
                 data-index="0"
                 onerror="this.src='${AppData.FALLBACK_IMAGE}'">
            <button class="tree-modal__close" aria-label="关闭" type="button">&times;</button>
            ${gallery.length > 1 ? `
              <div class="tree-modal__thumbs" role="tablist" aria-label="图片切换">
                ${gallery.map((g, i) => `
                  <img src="${e(g)}"
                       class="js-modal-thumb ${i === 0 ? 'is-active' : ''}"
                       data-index="${i}"
                       alt=""
                       loading="lazy"
                       onerror="this.style.display='none'">
                `).join('')}
              </div>
            ` : ''}
          </div>
          <div class="tree-modal__body">
            <h2 class="tree-modal__title" id="modal-title">${e(tree.name)}</h2>
            <div class="tree-modal__tags">${tagsHTML}</div>
            <div class="tree-modal__grid">
              <div>
                <h3>基本信息</h3>
                ${basicInfoHTML}
              </div>
              <div>
                <h3>保护与修复</h3>
                ${protectionHTML}
              </div>
            </div>
            <h3>历史与故事</h3>
            <div class="tree-modal__story">${story}</div>
            <h3>形态特征</h3>
            <p style="margin-bottom: 1.5rem;">${e(tree.feature)}</p>
            ${tree.pointcloud ? `
            <h3>3D 实景漫游</h3>
            <div class="tree-modal__pointcloud" data-pc="${e(tree.pointcloud)}">
              <div class="pc-loading">正在加载激光雷达实景点云…</div>
            </div>
            <p class="pc-hint">拖动旋转 · 滚轮缩放 · 右键平移。点云由激光雷达扫描重建，可远程查看古树实地形态。</p>
            ` : ''}
            <div class="tree-modal__actions">
              <button type="button" class="btn-view-map" data-action="view-map">在地图上查看</button>
              <button type="button" class="btn-virtual-tour" data-action="virtual-tour">虚拟游览</button>
              <button type="button" class="btn-favorite" data-action="favorite" data-tree-id="${tree.id}">★ 收藏</button>
            </div>
          </div>
        </div>`;

      document.body.appendChild(modal);
      this._current = modal;

      // 图册状态 + 缩略图点击切换主图
      modal._gallery = gallery;
      modal._galleryIdx = 0;
      const heroImg = modal.querySelector('.js-modal-hero');
      modal.querySelectorAll('.js-modal-thumb').forEach((thumb) => {
        thumb.addEventListener('click', () => {
          const idx = parseInt(thumb.dataset.index, 10);
          if (Number.isNaN(idx) || idx === modal._galleryIdx) return;
          modal._galleryIdx = idx;
          heroImg.src = modal._gallery[idx];
          heroImg.dataset.index = String(idx);
          modal.querySelectorAll('.js-modal-thumb').forEach((t) => {
            t.classList.toggle('is-active', parseInt(t.dataset.index, 10) === idx);
          });
        });
      });

      // 绑定事件
      const closeBtn = $('.tree-modal__close', modal);
      closeBtn.addEventListener('click', () => this.close());

      // 点击遮罩关闭
      modal.addEventListener('click', (event) => {
        if (event.target === modal) this.close();
      });

      // ESC 关闭
      this._escHandler = (event) => {
        if (event.key === 'Escape') this.close();
      };
      document.addEventListener('keydown', this._escHandler);

      // 在地图上查看
      const viewMapBtn = $('[data-action="view-map"]', modal);
      viewMapBtn.addEventListener('click', () => {
        this.close();
        byId('map').scrollIntoView({ behavior: 'smooth' });
        setTimeout(() => MapMgr.focusTree(tree), 500);
      });

      // 虚拟游览
      const tourBtn = $('[data-action="virtual-tour"]', modal);
      tourBtn.addEventListener('click', () => {
        this.close();
        byId('virtual').scrollIntoView({ behavior: 'smooth' });
        setTimeout(() => alert('开始' + tree.name + '的虚拟游览体验'), 500);
      });

      // 收藏（需登录）
      const favBtn = $('[data-action="favorite"]', modal);
      if (favBtn) {
        favBtn.addEventListener('click', async () => {
          const token = localStorage.getItem('museum_token');
          if (!token) { alert('请先登录后再收藏'); return; }
          try {
            const r = await fetch('/api/stats/favorites', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              body: JSON.stringify({ treeId: tree.id }),
            });
            const d = await r.json();
            if (r.ok) {
              favBtn.classList.add('is-faved');
              favBtn.textContent = '✓ 已收藏';
            } else {
              alert(d.error || '收藏失败');
            }
          } catch (e) {
            alert('网络错误');
          }
        });
      }

      // 3D 点云实景
      const pcEl = modal.querySelector('.tree-modal__pointcloud');
      if (pcEl) {
        modal._pcCleanup = PointCloudViewer.init(pcEl, pcEl.dataset.pc);
      }
    },

    /** 关闭弹窗 */
    close() {
      if (this._current) {
        if (this._current._pcCleanup) {
          try { this._current._pcCleanup(); } catch (e) { /* noop */ }
        }
        this._current.remove();
        this._current = null;
      }
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
      }
    },
  };

  /* ======================== PointCloudViewer (3D 实景) ======================== */
  /**
   * 懒加载 Three.js + PLYLoader + OrbitControls，渲染古树实景点云
   *  - 首次打开时才加载 CDN 脚本，避免无谓请求
   *  - 关闭弹窗时调用 cleanup 释放 WebGL 资源
   */
  const PointCloudViewer = {
    init(container, url) {
      if (container._pcInited) return () => {};
      container._pcInited = true;
      let disposed = false, renderer = null, raf = null, ro = null;

      loadThree(() => {
        if (disposed || !window.THREE || !THREE.PLYLoader || !THREE.OrbitControls) {
          const ld = container.querySelector('.pc-loading');
          if (ld) ld.textContent = '3D 组件加载失败（请检查网络后重试）';
          return;
        }
        const loading = container.querySelector('.pc-loading');
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0e160f);

        let w = container.clientWidth || 400;
        let h = container.clientHeight || 360;
        const camera = new THREE.PerspectiveCamera(60, w / h, 0.05, 2000);
        camera.up.set(0, 0, 1); // Z 轴朝上

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(w, h);
        container.appendChild(renderer.domElement);

        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;

        const loader = new THREE.PLYLoader();
        loader.load(url, (geometry) => {
          if (loading) loading.remove();
          geometry.computeBoundingBox();
          const material = new THREE.PointsMaterial({
            size: 0.06, vertexColors: true, sizeAttenuation: true,
          });
          const points = new THREE.Points(geometry, material);
          scene.add(points);

          const bb = geometry.boundingBox;
          const center = new THREE.Vector3();
          bb.getCenter(center);
          controls.target.copy(center);
          const size = new THREE.Vector3();
          bb.getSize(size);
          const radius = Math.max(size.x, size.y, size.z, 1) * 1.4;
          camera.position.set(center.x + radius, center.y - radius, center.z + radius * 0.8);
          camera.near = radius / 100;
          camera.far = radius * 20;
          camera.updateProjectionMatrix();
          controls.update();
        }, (xhr) => {
          if (loading && xhr.total) {
            loading.textContent = '正在加载实景点云… ' + Math.round(xhr.loaded / xhr.total * 100) + '%';
          }
        }, (err) => {
          if (loading) loading.textContent = '点云加载失败：' + ((err && err.message) || '未知错误');
        });

        const animate = () => {
          if (disposed) return;
          raf = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        ro = new ResizeObserver(() => {
          const W = container.clientWidth, H = container.clientHeight;
          if (!W || !H) return;
          camera.aspect = W / H;
          camera.updateProjectionMatrix();
          renderer.setSize(W, H);
        });
        ro.observe(container);
      });

      return () => {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        if (renderer) {
          renderer.dispose();
          if (renderer.domElement && renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
        }
      };
    },
  };

  // 顺序加载 Three.js 核心 + PLYLoader + OrbitControls（全局 THREE）
  let _threeQueue = null;
  function loadThree(cb) {
    if (window.THREE && THREE.PLYLoader && THREE.OrbitControls) { cb(); return; }
    if (_threeQueue) { _threeQueue.push(cb); return; }
    _threeQueue = [cb];
    const urls = [
      'https://unpkg.com/three@0.128.0/build/three.min.js',
      'https://unpkg.com/three@0.128.0/examples/js/loaders/PLYLoader.js',
      'https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js',
    ];
    let i = 0;
    (function next() {
      if (i >= urls.length) {
        const q = _threeQueue; _threeQueue = null;
        q.forEach((f) => f());
        return;
      }
      const s = document.createElement('script');
      s.src = urls[i++];
      s.onload = next;
      s.onerror = next; // 容错：失败也继续，最终由 init 内检测报错
      document.head.appendChild(s);
    })();
  }

  /* ======================== Lightbox ======================== */
  /**
   * 全屏图片查看器
   *  - open(src, gallery?, index?): 打开灯箱，gallery 不传则单图
   *  - 支持 ESC 关闭、← / → 切换、点击空白处关闭
   */
  const Lightbox = {
    _el: null,
    _imgs: [],
    _index: 0,
    _keyHandler: null,

    open(src, gallery, index) {
      this.close();
      const imgs = (Array.isArray(gallery) && gallery.length) ? gallery : [src];
      const start = Math.max(0, Math.min(index || 0, imgs.length - 1));
      const e = escapeHtml;

      const el = document.createElement('div');
      el.className = 'lightbox';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', '图片查看');
      el.innerHTML = `
        <button class="lightbox__close" type="button" aria-label="关闭">&times;</button>
        ${imgs.length > 1 ? `
          <button class="lightbox__nav lightbox__prev" type="button" aria-label="上一张">
            <i class="fas fa-chevron-left" aria-hidden="true"></i>
          </button>
          <button class="lightbox__nav lightbox__next" type="button" aria-label="下一张">
            <i class="fas fa-chevron-right" aria-hidden="true"></i>
          </button>
        ` : ''}
        <figure class="lightbox__stage">
          <img class="lightbox__img" src="${e(imgs[start])}" alt="">
        </figure>
        ${imgs.length > 1 ? `
          <div class="lightbox__counter" aria-live="polite">${start + 1} / ${imgs.length}</div>
        ` : ''}
      `;
      document.body.appendChild(el);
      document.body.style.overflow = 'hidden';

      this._el = el;
      this._imgs = imgs;
      this._index = start;

      // 关闭
      el.querySelector('.lightbox__close').addEventListener('click', () => this.close());
      el.addEventListener('click', (ev) => {
        if (ev.target === el) this.close();
      });

      // 切换
      if (imgs.length > 1) {
        el.querySelector('.lightbox__prev').addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._navigate(-1);
        });
        el.querySelector('.lightbox__next').addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._navigate(1);
        });
      }

      // 键盘
      this._keyHandler = (ev) => {
        if (ev.key === 'Escape') { this.close(); return; }
        if (imgs.length > 1) {
          if (ev.key === 'ArrowLeft') this._navigate(-1);
          else if (ev.key === 'ArrowRight') this._navigate(1);
        }
      };
      document.addEventListener('keydown', this._keyHandler);
    },

    _navigate(delta) {
      if (!this._el) return;
      this._index = (this._index + delta + this._imgs.length) % this._imgs.length;
      const img = this._el.querySelector('.lightbox__img');
      img.src = this._imgs[this._index];
      const counter = this._el.querySelector('.lightbox__counter');
      if (counter) counter.textContent = `${this._index + 1} / ${this._imgs.length}`;
    },

    close() {
      if (this._el) {
        this._el.remove();
        this._el = null;
        document.body.style.overflow = '';
      }
      if (this._keyHandler) {
        document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = null;
      }
    },
  };

  /* ======================== MapMgr ======================== */

  const MapMgr = {
    _map: null,
    _markers: [],
    _currentLayer: null,
    _amapLoaded: false,
    _fallbackActive: false,

    /** 销毁当前地图实例（兼容 Leaflet 和 AMap） */
    _destroyCurrentMap() {
      if (this._map) {
        try {
          if (this._fallbackActive && this._amapLoaded) {
            // AMap.Map 使用 destroy()
            if (typeof this._map.destroy === 'function') {
              this._map.destroy();
            }
          } else {
            // Leaflet 使用 remove()
            if (typeof this._map.remove === 'function') {
              this._map.remove();
            }
          }
        } catch (e) {
          console.warn('[古树博物馆] 地图销毁出错:', e);
        }
        this._map = null;
      }

      // 清除标记引用
      this._markers = [];

      // 用全新的 DOM 元素替换容器，彻底清除所有残留状态
      // （Leaflet 的 _leaflet_id、AMap 的内部属性、事件监听器等）
      if (DOM.mapContainer) {
        const oldEl = DOM.mapContainer;
        const newEl = document.createElement('div');
        newEl.id = oldEl.id;
        newEl.className = oldEl.className;
        oldEl.parentNode.replaceChild(newEl, oldEl);
        DOM.mapContainer = newEl;
      }
    },

    /** 构造地图弹窗 HTML：小导游立绘 + 一条合并字幕（位置/复壮/故事）+ 查看详情按钮
     *  Leaflet 与高德 InfoWindow 共用，避免代码重复 */
    _buildPopupHTML(tree) {
      const e = escapeHtml;
      const storyRaw = tree.description || '';
      const storyShort = storyRaw.length > 90 ? storyRaw.slice(0, 90) + '…' : storyRaw;
      const protection = tree.protectionMeasures || tree.maintenance || '日常巡查养护';
      return `
        <div class="tree-popup" style="min-width:250px;max-width:320px;font-family:'Times New Roman','Songti SC',serif;">
          <div class="tree-popup__head" style="background-color:#253926;color:white;padding:10px 12px;border-radius:6px 6px 0 0;">
            <h3 style="margin:0;font-size:1.05rem;">${e(tree.name)}</h3>
          </div>
          <div class="tree-popup__body" style="padding:12px;background:white;">
            <div class="popup-guide-mini">
              <img src="images/guide.png" alt="小导游" onerror="this.style.display='none'">
              <div class="popup-guide-text">
                <div class="popup-guide-greet">你好！这棵是 <strong>${e(tree.name)}</strong>，我来介绍~</div>
                <div class="popup-guide-line"><i class="fas fa-map-marker-alt"></i><span><b>位置：</b>${e(tree.location)}</span></div>
                <div class="popup-guide-line"><i class="fas fa-tools"></i><span><b>复壮：</b>${e(protection)}</span></div>
                <div class="popup-guide-line"><i class="fas fa-book-open"></i><span><b>故事：</b>${e(storyShort)}</span></div>
              </div>
            </div>
            <button type="button" class="popup-detail-btn" data-tree-id="${tree.id}"
              style="margin-top:10px;padding:8px 14px;background:#253926;color:white;border:none;border-radius:4px;cursor:pointer;width:100%;font-family:inherit;">
              查看完整介绍
            </button>
          </div>
        </div>`;
    },

    /** 文档级事件委托：「查看完整介绍」按钮点击 → 打开简介页弹窗（Leaflet/高德通用） */
    _bindDetailButtonDelegation() {
      if (this._detailBtnBound) return;
      this._detailBtnBound = true;
      document.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.popup-detail-btn[data-tree-id]');
        if (!btn) return;
        ev.stopPropagation();
        const id = parseInt(btn.getAttribute('data-tree-id'), 10);
        if (!Number.isNaN(id) && typeof Modal !== 'undefined') {
          Modal.show(id);
        }
      });
    },

    /** 初始化 Leaflet 卫星地图 */
    initSatellite() {
      this._destroyCurrentMap();

      const { lat, lng } = AppData.MEIZHOU_CENTER;
      this._map = L.map('tree-map').setView([lat, lng], AppData.MEIZHOU_ZOOM);

      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 18,
      }).addTo(this._map);

      this._addLeafletMarkers();
      L.control.scale({ imperial: false }).addTo(this._map);
      this._fallbackActive = false;
    },

    /** 添加 Leaflet 标记 */
    _addLeafletMarkers() {
      // 清除旧标记
      this._markers.forEach((m) => m.remove());
      this._markers = [];

      AppData.treesData.forEach((tree) => {
        // 每棵树创建独立的 divIcon，将编号和样式直接嵌入 HTML
        // 修复：原代码在 addTo 之前调用 getElement() 返回 null，导致标记无样式
        const icon = L.divIcon({
          className: 'tree-marker',
          html: '<div style="background-color:#253926;color:white;width:32px;height:32px;border-radius:50%;' +
                'display:flex;align-items:center;justify-content:center;font-weight:bold;' +
                'border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);font-size:14px;cursor:pointer;' +
                'font-family:\'Times New Roman\',\'Songti SC\',serif;">' +
                tree.id + '</div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        const marker = L.marker([tree.lat, tree.lng], { icon, title: tree.name });
        marker.bindPopup(this._buildPopupHTML(tree));
        this._bindDetailButtonDelegation();
        marker.addTo(this._map);
        this._markers.push(marker);
      });

      // 不自动适配视野 —— 118棵树分布太广，fitBounds 会缩太远
      // 保持 initSatellite 中设置的梅州中心默认视野
    },

    /** 加载高德地图 */
    loadAmap() {
      if (this._amapLoaded) {
        this._switchToAmap();
        return;
      }

      const script = document.createElement('script');
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${AppData.AMAP_KEY}`;

      script.onload = () => {
        this._amapLoaded = true;
        this._switchToAmap();
      };

      script.onerror = () => {
        alert('高德地图加载失败，请检查网络连接');
        // 回退到 Leaflet
        this._fallbackActive = false;
        this.initSatellite();
      };

      document.head.appendChild(script);
    },

    /** 切换到高德地图 */
    _switchToAmap() {
      this._destroyCurrentMap();

      const { lat, lng } = AppData.MEIZHOU_CENTER;
      this._map = new AMap.Map('tree-map', {
        zoom: AppData.MEIZHOU_ZOOM,
        center: [lng, lat],
        viewMode: '2D',
        mapStyle: 'amap://styles/satellite',
      });

      // 关键：在可能抛异常的代码之前就标记状态
      // 修复：原代码 AMap.Scale/ToolBar 是插件，new 会抛 TypeError，
      //       导致 _fallbackActive = true 永远不执行，切回卫星时走错分支
      this._fallbackActive = true;

      // 添加高德标记 —— 使用 forEach + 闭包正确捕获 tree
      this._bindDetailButtonDelegation();
      const popupHTMLCache = {};
      AppData.treesData.forEach((tree) => {
        const marker = new AMap.Marker({
          position: [tree.lng, tree.lat],
          title: tree.name,
          content: `<div style="background:#253926;color:white;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;border:2px solid white;font-family:'Times New Roman','Songti SC',serif;">${tree.id}</div>`,
          offset: new AMap.Pixel(-16, -16),
        });

        // 使用 InfoWindow 弹出小导游字幕 + 查看完整介绍按钮（与卫星地图一致体验）
        const info = popupHTMLCache[tree.id] || (popupHTMLCache[tree.id] = new AMap.InfoWindow({
          content: this._buildPopupHTML(tree),
          offset: new AMap.Pixel(0, -36),
          closeWhenClickMap: true,
          autoMove: true,
        }));

        marker.on('click', () => {
          info.open(this._map, [tree.lng, tree.lat]);
        });

        marker.setMap(this._map);
      });

      // 比例尺和工具条是 AMap 插件，需异步加载，这里容错处理
      try {
        AMap.plugin(['AMap.Scale', 'AMap.ToolBar'], () => {
          this._map.addControl(new AMap.Scale());
          this._map.addControl(new AMap.ToolBar());
        });
      } catch (e) {
        console.warn('[古树博物馆] 高德地图控件加载失败:', e);
      }
    },

    /** 重置地图视野 */
    resetView() {
      if (!this._map) return;

      const { lat, lng } = AppData.MEIZHOU_CENTER;

      if (this._fallbackActive && this._map.setCenter) {
        // 高德地图 API
        this._map.setCenter([lng, lat]);
      } else if (this._map.setView) {
        // Leaflet API
        this._map.setView([lat, lng], AppData.MEIZHOU_ZOOM);
      }
    },

    /** 聚焦到指定古树并打开弹窗 */
    focusTree(tree) {
      if (!this._map || !tree) return;

      if (this._fallbackActive && this._map.setZoomAndCenter) {
        // 高德地图
        this._map.setZoomAndCenter(16, [tree.lng, tree.lat]);
      } else if (this._map.setView) {
        // Leaflet
        this._map.setView([tree.lat, tree.lng], 16);

        // 找到对应标记并打开弹窗
        const marker = this._markers.find((m) => {
          const ll = m.getLatLng();
          return Math.abs(ll.lat - tree.lat) < 0.0001 && Math.abs(ll.lng - tree.lng) < 0.0001;
        });
        if (marker) marker.openPopup();
      }
    },

    /** 设置按钮激活状态 */
    setActiveButton(activeBtn) {
      [DOM.satelliteMapBtn, DOM.fallbackMapBtn].forEach((btn) => {
        if (btn) btn.classList.remove('active');
      });
      if (activeBtn) activeBtn.classList.add('active');
    },
  };

  /* ======================== App ======================== */

  const App = {
    /** 初始化移动端菜单 */
    _setupMobileMenu() {
      const btn = DOM.mobileMenuBtn;
      const nav = DOM.mainNav;
      if (!btn || !nav) return;

      const icon = btn.querySelector('i');

      btn.addEventListener('click', () => {
        const isShown = nav.classList.toggle('show');
        btn.setAttribute('aria-expanded', isShown);
        if (icon) {
          icon.className = isShown ? 'fas fa-times' : 'fas fa-bars';
        }
      });
    },

    /** 初始化平滑滚动导航 */
    _setupSmoothScroll() {
      $all('nav a, .cta-button').forEach((link) => {
        link.addEventListener('click', (e) => {
          const href = link.getAttribute('href');
          if (!href || !href.startsWith('#')) return;

          e.preventDefault();
          const target = $(href);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
          }

          // 移动端：点击后收起菜单
          if (window.innerWidth <= 768) {
            DOM.mainNav.classList.remove('show');
            const icon = DOM.mobileMenuBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-bars';
            DOM.mobileMenuBtn.setAttribute('aria-expanded', 'false');
          }
        });
      });
    },

    /** 初始化地图控制按钮 */
    _setupMapControls() {
      DOM.satelliteMapBtn.addEventListener('click', () => {
        MapMgr.setActiveButton(DOM.satelliteMapBtn);
        MapMgr.initSatellite();
      });

      DOM.fallbackMapBtn.addEventListener('click', () => {
        MapMgr.setActiveButton(DOM.fallbackMapBtn);
        MapMgr.loadAmap();
      });

      DOM.resetViewBtn.addEventListener('click', () => {
        MapMgr.resetView();
      });
    },

    /** 初始化虚拟游览按钮 */
    _setupVirtualTour() {
      DOM.virtualTourBtn.addEventListener('click', () => {
        alert('虚拟游览功能开发中，即将推出！');
      });
    },

    /** 初始化古树容器事件委托（只绑一次，修复重复绑定 Bug） */
    _setupTreeContainer() {
      if (!DOM.treesContainer) return;

      DOM.treesContainer.addEventListener('click', (e) => {
        // 点击"查看更多"链接
        const link = e.target.closest('.tree-link');
        if (link) {
          e.preventDefault();
          const id = parseInt(link.getAttribute('data-tree-id'), 10);
          Modal.show(id);
          return;
        }

        // 点击"加载更多"按钮
        const loadBtn = e.target.closest('#loadMoreBtn');
        if (loadBtn) {
          Renderer._currentPage++;
          Renderer._renderFlat();
          return;
        }

        // 点击分组标题 —— 展开/折叠
        const groupHeader = e.target.closest('.taxonomy-group__header');
        if (groupHeader) {
          const group = groupHeader.parentElement;
          const isExpanded = group.classList.toggle('expanded');
          groupHeader.setAttribute('aria-expanded', isExpanded);
        }
      });

      // 键盘支持：分组标题 Enter/Space 切换
      DOM.treesContainer.addEventListener('keydown', (e) => {
        const groupHeader = e.target.closest('.taxonomy-group__header');
        if (groupHeader && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          const group = groupHeader.parentElement;
          const isExpanded = group.classList.toggle('expanded');
          groupHeader.setAttribute('aria-expanded', isExpanded);
        }
      });
    },

    /** 初始化视图切换按钮 */
    _setupViewToggle() {
      const buttons = $all('.view-toggle-btn');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          buttons.forEach((b) => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
          });
          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
          Renderer.setViewMode(btn.getAttribute('data-view'));
        });
      });
    },

    /** 初始化古树搜索框：实时过滤 + 清除按钮 */
    _setupTreeSearch() {
      const input = DOM.treeSearchInput;
      const clearBtn = DOM.treeSearchClear;
      if (!input) return;

      // 防抖：连续输入时 80ms 内只渲染一次
      let timer = null;
      const trigger = () => {
        clearTimeout(timer);
        timer = setTimeout(() => Renderer.setSearch(input.value), 80);
      };

      input.addEventListener('input', trigger);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && input.value) {
          ev.preventDefault();
          input.value = '';
          Renderer.setSearch('');
          input.blur();
        }
      });

      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          input.value = '';
          Renderer.setSearch('');
          input.focus();
        });
      }
    },

    /** 全局图片点击 → 打开 Lightbox（所有 js-viewable 图片均可点击查看） */
    _setupImageLightbox() {
      document.addEventListener('click', (ev) => {
        const el = ev.target.closest('.js-viewable');
        if (!el) return;
        // 排除缩略图自身（缩略图走切换主图逻辑，不开灯箱）
        if (el.classList.contains('js-modal-thumb')) return;
        ev.preventDefault();

        const treeId = el.dataset.treeId;
        const index = parseInt(el.dataset.index || '0', 10) || 0;
        let gallery = null;
        if (treeId) {
          const tree = AppData.treesData.find((t) => String(t.id) === String(treeId));
          if (tree) {
            gallery = (tree.gallery && tree.gallery.length) ? tree.gallery : [tree.image];
          }
        }
        if (!gallery) gallery = [el.dataset.src || el.src];
        Lightbox.open(gallery[0], gallery, index);
      });
    },

    /** 滚动时高亮当前导航项 */
    _setupScrollSpy() {
      const navLinks = $all('nav a');
      const sections = navLinks
        .map((link) => {
          const href = link.getAttribute('href');
          return href && href.startsWith('#') ? $(href) : null;
        })
        .filter(Boolean);

      window.addEventListener('scroll', () => {
        const scrollY = window.scrollY + 100;
        let currentIdx = 0;

        sections.forEach((section, idx) => {
          if (section.offsetTop <= scrollY) {
            currentIdx = idx;
          }
        });

        navLinks.forEach((link, idx) => {
          link.classList.toggle('active', idx === currentIdx);
        });
      });
    },

    /** 启动应用 */
    init() {
      // 防止重复初始化（脚本末尾同时注册了 DOMContentLoaded 与立即调用）
      if (this._inited) return;
      this._inited = true;

      // 优先从后端 /api/trees 拉取数据；失败回退到本地 data.js（window.AppData）
      this._loadData().finally(() => {
        safeParse(() => {
          // 1. 缓存 DOM
          initDOMCache();

          // 2. 渲染视图
          Renderer.render();
          Renderer.renderRestorationMethods();
          Renderer.updateStats();

          // 3. 绑定交互事件（优先绑定：确保照片查看等在任何情况下都可用）
          this._setupMobileMenu();
          this._setupSmoothScroll();
          this._setupMapControls();
          this._setupVirtualTour();
          this._setupTreeContainer();
          this._setupViewToggle();
          this._setupTreeSearch();
          this._setupImageLightbox();
          this._setupScrollSpy();
          this._setupAccount(); // 登录 / 收藏 / 留言 / 统计埋点

          // 4. 初始化地图（独立容错：地图加载失败不影响上方的交互绑定）
          try {
            MapMgr.initSatellite();
          } catch (e) {
            console.warn('[古树博物馆] 地图初始化失败，不影响照片查看等交互:', e);
          }
        });
      });
    },

    /** 从后端加载古树数据；失败则用本地 data.js 兜底 */
    async _loadData() {
      try {
        const resp = await fetch('/api/trees');
        if (resp.ok) {
          const data = await resp.json();
          if (data && Array.isArray(data.trees) && data.trees.length) {
            window.AppData.treesData = data.trees;
            console.log('[古树博物馆] 已从后端加载 ' + data.trees.length + ' 棵古树');
          }
        }
      } catch (e) {
        console.warn('[古树博物馆] 后端数据加载失败，使用本地 data.js 兜底:', e);
      }
    },

    /** 账户与互动入口：登录态、收藏、留言、访问埋点 */
    _setupAccount() {
      const self = this;
      const loginBtn = byId('navLoginBtn');
      const meBox = byId('navUserBox');
      const msgBtn = byId('navMsgBtn');

      const renderAuth = () => {
        const token = localStorage.getItem('museum_token');
        if (token && meBox) {
          try {
            const u = JSON.parse(localStorage.getItem('museum_user') || '{}');
            meBox.textContent = (u.username || '已登录') + '（' + (u.role || '') + '）';
            meBox.classList.remove('hidden');
            if (loginBtn) loginBtn.textContent = '退出';
          } catch (e) {}
        } else if (meBox) {
          meBox.classList.add('hidden');
          if (loginBtn) loginBtn.textContent = '登录';
        }
      };

      if (loginBtn) {
        loginBtn.addEventListener('click', () => {
          const token = localStorage.getItem('museum_token');
          if (token) {
            localStorage.removeItem('museum_token');
            localStorage.removeItem('museum_user');
            renderAuth();
            location.reload();
            return;
          }
          self._openLoginModal(renderAuth);
        });
      }

      if (msgBtn) {
        msgBtn.addEventListener('click', () => self._openMessageModal());
      }

      renderAuth();
      // 访问统计埋点
      fetch('/api/stats/visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname }),
      }).catch(() => {});
    },

    /** 登录弹窗 */
    _openLoginModal(cb) {
      let modal = byId('loginModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'loginModal';
        modal.className = 'modal login-modal';
        modal.innerHTML =
          '<div class="modal__content login-modal__content">' +
          '<button class="modal__close" id="loginClose">×</button>' +
          '<h3>登录古树博物馆</h3>' +
          '<label>用户名</label><input id="loginUser" value="admin">' +
          '<label>密码</label><input id="loginPwd" type="password" value="admin123">' +
          '<button id="loginSubmit" style="margin-top:12px;width:100%;">登录</button>' +
          '<p class="notice">默认账号 admin / admin123（登录后请修改密码）</p></div>';
        document.body.appendChild(modal);
        byId('loginClose').onclick = () => modal.classList.remove('is-open');
        byId('loginSubmit').onclick = async () => {
          const r = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: byId('loginUser').value, password: byId('loginPwd').value }),
          });
          const d = await r.json();
          if (r.ok) {
            localStorage.setItem('museum_token', d.token);
            localStorage.setItem('museum_user', JSON.stringify(d.user));
            modal.classList.remove('is-open');
            if (cb) cb();
            location.reload();
          } else {
            alert(d.error || '登录失败');
          }
        };
      }
      modal.classList.add('is-open');
    },

    /** 留言弹窗 */
    _openMessageModal() {
      let modal = byId('msgModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'msgModal';
        modal.className = 'modal login-modal';
        modal.innerHTML =
          '<div class="modal__content login-modal__content">' +
          '<button class="modal__close" id="msgClose">×</button>' +
          '<h3>留言</h3>' +
          '<textarea id="msgContent" rows="4" placeholder="说点什么…"></textarea>' +
          '<button id="msgSubmit" style="margin-top:10px;width:100%;">提交留言</button>' +
          '<p class="notice">需登录后留言</p></div>';
        document.body.appendChild(modal);
        byId('msgClose').onclick = () => modal.classList.remove('is-open');
        byId('msgSubmit').onclick = async () => {
          const token = localStorage.getItem('museum_token');
          if (!token) { alert('请先登录'); return; }
          const content = byId('msgContent').value.trim();
          if (!content) { alert('内容不能为空'); return; }
          const r = await fetch('/api/stats/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ content }),
          });
          const d = await r.json();
          if (r.ok) { alert('留言成功'); modal.classList.remove('is-open'); }
          else alert(d.error || '失败');
        };
      }
      modal.classList.add('is-open');
    },
  };

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }
})();
