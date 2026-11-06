/**
 * dsh-plugin-categories — client half.
 *
 * The Plugins page has no slot that can wrap or replace its "installed" list, so
 * this half works on the rendered DOM instead: the page already marks every
 * card with `li[data-plugin-package]` and every group with
 * `section[data-plugin-group]`. The "packages you installed" group is
 * `data-plugin-group="bundles"`.
 *
 * What we add, without ever touching React's own nodes:
 *   - one collapsible header per named category, inserted into the group's
 *     card list and ordered with the CSS `order` property,
 *   - a small select inside every card that files that package under a category,
 *   - a "分类" button in the group head that opens the category editor.
 *
 * The layout itself lives in the host half (a `webServer` route); this half only
 * reads and writes it, and keeps a browser copy so the UI still works when the
 * route is unavailable.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-categories',
  factory() {
    return {
      inject: [],
      apply(ctx) {
        if (typeof document === 'undefined') return

        // ----------------------------------------------------------------
        // constants
        // ----------------------------------------------------------------
        const SCHEMA_VERSION = 1
        const ROUTE = 'dsh-plugin-categories/state'
        const LS_KEY = 'dsh-plugin-categories:state'
        const STYLE_ID = 'dsh-plugin-categories:style'
        const MAX_NAME = 60
        /** Sentinel id for the "uncategorized" header. */
        const UNCAT = '__uncategorized__'
        /** Flex `order` stride between two categories. */
        const STRIDE = 10000
        /** Attribute names this half owns. */
        const ATTR = {
          head: 'data-dshpc-head',
          manage: 'data-dshpc-manage',
          assign: 'data-dshpc-assign',
          sig: 'data-dshpc-sig',
          editor: 'data-dshpc-editor',
          /** 整组折叠开关（basic / extensions 用，独立于分类体系）。 */
          groupToggle: 'data-dshpc-group-toggle',
        }

        // ----------------------------------------------------------------
        // copy (the host page is monolingual per request, so this is enough)
        // ----------------------------------------------------------------
        const zh = {
          panelTitle: '插件分类',
          namePlaceholder: '分类名称',
          add: '添加',
          done: '完成',
          uncategorized: '未分类',
          empty: '还没有分类。输入名称后点“添加”。',
          hint: '进入编辑模式后，每张插件卡片右侧会出现下拉框，把插件放进分类；点“完成”即退出编辑模式。',
          edit: '编辑',
          finish: '完成',
          editTitle: '进入编辑模式：每张卡片右侧出现分类下拉框',
          finishTitle: '退出编辑模式：隐藏分类下拉框',
          renameAria: '分类名称',
          up: '上移',
          down: '下移',
          remove: '删除分类',
          offline: '没有连上宿主，分类暂时存在本机浏览器里。',
          count: (n) => `${n} 个`,
          undo: (name) => `撤销删除「${name}」`,
          assignAria: '把插件放进分类',
          expandHint: '展开这个分类',
          collapseHint: '收起这个分类',
          arrangingHint: '整理时分类保持展开',
          expandGroup: '展开这组插件',
          collapseGroup: '收起这组插件',
        }
        const en = {
          panelTitle: 'Plugin categories',
          namePlaceholder: 'Category name',
          add: 'Add',
          done: 'Done',
          uncategorized: 'Uncategorized',
          empty: 'No categories yet. Type a name and press Add.',
          hint: 'Pick a category on the right of each card to file that package; press Done to leave edit mode.',
          edit: 'Edit',
          finish: 'Done',
          editTitle: 'Enter edit mode: a category dropdown appears on every card',
          finishTitle: 'Leave edit mode: hide the category dropdowns',
          renameAria: 'Category name',
          up: 'Move up',
          down: 'Move down',
          remove: 'Delete category',
          offline: 'Host unreachable; categories are kept in this browser for now.',
          count: (n) => `${n}`,
          undo: (name) => `Undo deleting “${name}”`,
          assignAria: 'File this package under a category',
          expandHint: 'Expand this category',
          collapseHint: 'Collapse this category',
          arrangingHint: 'Categories stay open while arranging',
          expandGroup: 'Expand this group',
          collapseGroup: 'Collapse this group',
        }
        const lang = String(document.documentElement.getAttribute('lang') ?? navigator.language ?? 'zh')
        const t = /^en/iu.test(lang) ? en : zh

        // ----------------------------------------------------------------
        // mutable module state
        // ----------------------------------------------------------------
        let state = emptyState()
        let loaded = false
        let offline = false
        let disposed = false
        let syncing = false
        let syncQueued = false
        let saveTimer = null
        let scanTimer = null
        let observer = null
        /** The inline editor card, while edit mode is on. */
        let panel = null
        let draftName = ''
        let undo = null
        /**
         * Whether the user is filing packages right now. This is a transient
         * UI mode, deliberately NOT persisted: a normal visit to the page shows
         * the categories and nothing else, and both the pickers and the editor
         * appear only while the user is actually arranging things.
         */
        let editMode = false

        function warn(message, error) {
          const detail = error instanceof Error ? error.message : String(error ?? '')
          try {
            console.warn(`[dsh-plugin-categories] ${message}${detail === '' ? '' : `: ${detail}`}`)
          } catch {
            /* console is best-effort */
          }
        }

        function emptyState() {
          return {
            version: SCHEMA_VERSION,
            categories: [],
            uncategorizedCollapsed: false,
            // 整组折叠：官方的「内置」「实验性」两组各一个独立开关，与分类体系无关。
            collapsedGroups: {},
          }
        }

        function clampName(value) {
          return String(value ?? '')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, MAX_NAME)
        }

        function makeId() {
          return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
        }

        /** Accepts anything and returns a layout this half can render. */
        function normalize(raw) {
          const out = emptyState()
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
          // A payload this half does not understand is treated as "no layout
          // yet", exactly like the host half does, instead of being guessed at.
          if (raw.version !== SCHEMA_VERSION) return out
          if (raw.uncategorizedCollapsed === true) out.uncategorizedCollapsed = true
          // 整组折叠标志：按组 id 各存一个布尔，缺省 false。
          if (raw.collapsedGroups !== null && typeof raw.collapsedGroups === 'object' && !Array.isArray(raw.collapsedGroups)) {
            for (const key of ['basic', 'extensions']) {
              if (raw.collapsedGroups[key] === true) out.collapsedGroups[key] = true
            }
          }
          const list = Array.isArray(raw.categories) ? raw.categories : []
          const usedIds = new Set()
          for (const entry of list) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
            const name = clampName(entry.name)
            if (name === '') continue
            let id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : makeId()
            if (usedIds.has(id)) id = makeId()
            usedIds.add(id)
            const packages = []
            for (const value of Array.isArray(entry.packages) ? entry.packages : []) {
              if (typeof value !== 'string' || value === '' || packages.includes(value)) continue
              packages.push(value)
            }
            out.categories.push({ id, name, collapsed: entry.collapsed === true, packages })
          }
          // One package lives in exactly one category; the first claim wins.
          const claimed = new Set()
          for (const category of out.categories) {
            category.packages = category.packages.filter((name) => {
              if (claimed.has(name)) return false
              claimed.add(name)
              return true
            })
          }
          return out
        }

        // ----------------------------------------------------------------
        // transport: host route first, browser copy second
        // ----------------------------------------------------------------
        function endpoint() {
          const base = new URL(document.baseURI)
          base.search = ''
          base.hash = ''
          if (!base.pathname.endsWith('/')) base.pathname += '/'
          return new URL(ROUTE, base).href
        }

        async function fetchState() {
          const response = await fetch(endpoint(), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload === null || payload.ok !== true) throw new Error('bad reply')
          return normalize(payload.state)
        }

        async function pushState(next) {
          const response = await fetch(endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: next }),
            cache: 'no-store',
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload === null || payload.ok !== true) throw new Error('bad reply')
          return payload.state === undefined ? next : normalize(payload.state)
        }

        function loadLocal() {
          try {
            const raw = localStorage.getItem(LS_KEY)
            if (raw === null || raw === '') return null
            return normalize(JSON.parse(raw))
          } catch {
            return null
          }
        }

        function saveLocal(next) {
          try {
            localStorage.setItem(LS_KEY, JSON.stringify(next))
          } catch {
            /* quota or private mode: the host copy still exists */
          }
        }

        async function load() {
          try {
            state = await fetchState()
            offline = false
          } catch (error) {
            state = loadLocal() ?? emptyState()
            offline = true
            warn('state route unavailable, using the browser copy', error)
          }
          loaded = true
          scheduleSync()
          if (editMode) renderPanel()
        }

        function persist() {
          saveLocal(state)
          if (saveTimer !== null) return
          saveTimer = setTimeout(async () => {
            saveTimer = null
            if (disposed || offline) return
            try {
              await pushState(state)
            } catch (error) {
              offline = true
              warn('could not save to the host, keeping the browser copy', error)
              if (editMode) renderPanel()
            }
          }, 180)
        }

        // ----------------------------------------------------------------
        // mutations
        // ----------------------------------------------------------------
        function commit(next) {
          state = normalize(next)
          persist()
          scheduleSync()
          if (editMode) renderPanel()
        }

        function categoryOf(id) {
          return state.categories.find((entry) => entry.id === id) ?? null
        }

        function categoryIdOf(packageName) {
          for (const category of state.categories) {
            if (category.packages.includes(packageName)) return category.id
          }
          return null
        }

        function addCategory(rawName) {
          const name = clampName(rawName)
          if (name === '') return null
          const category = { id: makeId(), name, collapsed: false, packages: [] }
          commit({ ...state, categories: [...state.categories, category] })
          return category
        }

        function renameCategory(id, rawName) {
          const name = clampName(rawName)
          const current = categoryOf(id)
          if (current === null || name === '' || current.name === name) return
          commit({
            ...state,
            categories: state.categories.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
          })
        }

        function deleteCategory(id) {
          const index = state.categories.findIndex((entry) => entry.id === id)
          if (index < 0) return
          undo = { category: state.categories[index], index }
          commit({ ...state, categories: state.categories.filter((entry) => entry.id !== id) })
        }

        function restoreDeleted() {
          if (undo === null) return
          const list = state.categories.slice()
          list.splice(Math.min(undo.index, list.length), 0, undo.category)
          undo = null
          commit({ ...state, categories: list })
        }

        function moveCategory(id, delta) {
          const list = state.categories.slice()
          const from = list.findIndex((entry) => entry.id === id)
          const to = from + delta
          if (from < 0 || to < 0 || to >= list.length) return
          const [moved] = list.splice(from, 1)
          list.splice(to, 0, moved)
          commit({ ...state, categories: list })
        }

        /** Files `packageName` under `id`, or back to uncategorized when null. */
        function assign(packageName, id) {
          if (packageName === '') return
          const categories = state.categories.map((entry) => ({
            ...entry,
            packages: entry.packages.filter((name) => name !== packageName),
          }))
          if (id !== null) {
            const target = categories.find((entry) => entry.id === id)
            if (target !== undefined) target.packages = [...target.packages, packageName]
          }
          commit({ ...state, categories })
        }

        function setCollapsed(id, collapsed) {
          if (id === UNCAT) {
            commit({ ...state, uncategorizedCollapsed: collapsed })
            return
          }
          commit({
            ...state,
            categories: state.categories.map((entry) =>
              entry.id === id ? { ...entry, collapsed } : entry,
            ),
          })
        }

        function toggleCollapsed(id) {
          // Edit mode keeps every group open on purpose, so the chevron must not
          // pretend to work: a click that silently mutated the stored flag would
          // collapse the group the moment the user leaves edit mode.
          if (editMode) return
          if (id === UNCAT) setCollapsed(UNCAT, !state.uncategorizedCollapsed)
          else {
            const category = categoryOf(id)
            if (category !== null) setCollapsed(id, !category.collapsed)
          }
        }

        // ----------------------------------------------------------------
        // styling
        // ----------------------------------------------------------------
        const CSS = `
.dshpc-head{display:flex;align-items:center;gap:6px;margin:12px -8px 2px;padding:4px 8px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;user-select:none;list-style:none}
.dshpc-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.12))}
.dshpc-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px}
.dshpc-chevron{display:inline-flex;flex:none;opacity:.75;transition:transform .16s ease}
.dshpc-head[aria-expanded="true"] .dshpc-chevron{transform:rotate(90deg)}
/* 整组折叠开关（basic / extensions 组头），复用分类头箭头的观感。 */
.dshpc-group-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;margin-right:2px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;opacity:.75;cursor:pointer;transition:transform .16s ease,opacity .12s ease,background .12s ease}
.dshpc-group-toggle:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.12))}
.dshpc-group-toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px;opacity:1}
.dshpc-group-toggle[aria-expanded="true"]{transform:rotate(90deg)}
.dshpc-group-toggle[aria-expanded="false"]{transform:rotate(0deg)}
.dshpc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.dshpc-count{color:var(--dsw-alias-label-tertiary,#999);font-weight:400;font-variant-numeric:tabular-nums}
.dshpc-manage{flex:none;display:inline-flex;align-items:center;gap:4px;margin:0;padding:2px 8px;border:0;background:transparent;border-radius:var(--dsw-radius-sm,6px);color:color-mix(in srgb,var(--dsw-alias-label-secondary,#6b6b6b) 70%,var(--dsw-alias-label-tertiary,#999));font:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer}
.dshpc-manage:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.12));color:var(--dsw-alias-label-primary,#111)}
.dshpc-manage:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px}
.dshpc-manage-on{background:var(--dsw-alias-state-business-primary,#3d6dfa);color:#fff;font-weight:500}
.dshpc-manage-on:hover{background:var(--dsw-alias-state-business-primary,#3d6dfa);color:#fff;filter:brightness(1.08)}
.dshpc-assign{position:relative;z-index:2;flex:none;max-width:132px;padding:2px 4px;font:inherit;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b6b6b);background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.08));border:.5px solid var(--dsw-alias-border-l2,rgba(120,120,120,.22));border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.dshpc-assign:hover{color:var(--dsw-alias-label-primary,#111);border-color:var(--dsw-alias-border-l3,rgba(120,120,120,.35))}
.dshpc-assign:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px}
.dshpc-editor{display:flex;flex-direction:column;gap:12px;margin:2px -8px 10px;padding:14px;background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.06));border:.5px solid var(--dsw-alias-border-l2,rgba(120,120,120,.22));border-radius:var(--dsw-radius-lg,10px);color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:20px}
.dshpc-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dshpc-row{display:flex;align-items:center;gap:8px}
.dshpc-input{box-sizing:border-box;flex:1;min-width:0;padding:5px 8px;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.08));border:.5px solid var(--dsw-alias-border-l2,rgba(120,120,120,.22));border-radius:var(--dsw-radius-sm,6px);font:inherit}
.dshpc-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px}
.dshpc-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dshpc-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.06))}
.dshpc-item .dshpc-input{background:var(--dsw-alias-bg-layer-1,#fff)}
.dshpc-item .dshpc-count{flex:none;white-space:nowrap}
.dshpc-actions{display:flex;flex:none;align-items:center;gap:2px}
.dshpc-icon{width:24px;height:24px;padding:0;border:0;background:transparent;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-secondary,#6b6b6b);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dshpc-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.14));color:var(--dsw-alias-label-primary,#111)}
.dshpc-icon:disabled{opacity:.35;cursor:default}
.dshpc-danger:hover{color:var(--dsw-alias-state-error-primary,#d64545)}
.dshpc-empty{margin:0;padding:14px 8px;color:var(--dsw-alias-label-tertiary,#999);text-align:center}
.dshpc-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dshpc-footer{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.dshpc-note{flex:1;color:var(--dsw-alias-state-warn-primary,#b8860b);font-size:12px;line-height:18px}
.dshpc-button{flex:none;padding:4px 12px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2,rgba(120,120,120,.22));background:var(--dsw-alias-bg-layer-2,rgba(120,120,120,.08));color:var(--dsw-alias-label-primary,#111);font:inherit;font-weight:500;cursor:pointer}
.dshpc-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.16))}
.dshpc-primary{background:var(--dsw-alias-state-business-primary,#3d6dfa);border-color:transparent;color:#fff}
.dshpc-primary:hover{background:var(--dsw-alias-state-business-primary,#3d6dfa);filter:brightness(1.08)}
.dshpc-button:focus-visible,.dshpc-icon:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a90ff);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.dshpc-chevron,.dshpc-group-toggle{transition:none}}
`

        function ensureStyle() {
          if (document.getElementById(STYLE_ID) !== null) return
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          ;(document.head ?? document.documentElement).appendChild(style)
        }

        // ----------------------------------------------------------------
        // DOM: the "packages you installed" group
        // ----------------------------------------------------------------
        function groupSection() {
          return document.querySelector('section[data-plugin-group="bundles"]')
        }

        /**
         * The host's own card list: the section's direct-child <ul>.
         *
         * This deliberately does not use `section.querySelector('ul')`, because
         * the inline editor also contains a <ul> of its own and sits inside this
         * same section — a plain subtree query would return the editor's list
         * and the grouping would fall apart on the very next pass.
         */
        function cardList(section) {
          for (const child of section.children) {
            if (child instanceof HTMLElement && child.tagName === 'UL') return child
          }
          return null
        }

        function packageCards(list) {
          const cards = []
          for (const node of list.children) {
            if (node instanceof HTMLElement && node.tagName === 'LI' && node.hasAttribute('data-plugin-package')) {
              cards.push(node)
            }
          }
          return cards
        }

        function packageNameOf(card) {
          return card.getAttribute('data-plugin-package') ?? ''
        }

        /**
         * 整组折叠：给 basic / extensions 两组的组标题各加一个独立开关。
         * 折叠时隐藏该组的 <ul>，各组状态独立存储，互不影响；bundles 组
         * 走分类体系，不在此处理。
         */
        function groupHead(section) {
          return section.querySelector('[class*="_groupHead"]') ??
            (section.firstElementChild instanceof HTMLElement ? section.firstElementChild : null)
        }

        function applyGroupCollapsed(section, collapsed) {
          const list = cardList(section)
          if (list !== null) {
            if (collapsed) {
              if (list.style.display !== 'none') list.style.display = 'none'
            } else if (list.style.display === 'none') {
              list.style.removeProperty('display')
            }
          }
          const head = groupHead(section)
          if (head === null) return
          const toggle = head.querySelector(`[${ATTR.groupToggle}]`)
          if (toggle === null) return
          const expanded = !collapsed
          if (toggle.getAttribute('aria-expanded') !== (expanded ? 'true' : 'false')) {
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
          }
          toggle.classList.toggle('dshpc-group-collapsed', collapsed)
          const label = collapsed ? t.expandGroup : t.collapseGroup
          if (toggle.title !== label) toggle.title = label
        }

        function toggleGroupCollapsed(groupId) {
          const next = state.collapsedGroups[groupId] !== true
          if (next) state.collapsedGroups[groupId] = true
          else delete state.collapsedGroups[groupId]
          persist()
          scheduleSync()
        }

        function mountGroupCollapse(section, groupId) {
          const head = groupHead(section)
          if (head === null) return
          let toggle = head.querySelector(`[${ATTR.groupToggle}]`)
          if (toggle === null) {
            toggle = document.createElement('button')
            toggle.type = 'button'
            toggle.className = 'dshpc-group-toggle'
            toggle.setAttribute(ATTR.groupToggle, '')
            toggle.setAttribute('aria-expanded', 'true')
            toggle.innerHTML =
              '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>'
            toggle.addEventListener('click', (event) => {
              event.stopPropagation()
              toggleGroupCollapsed(groupId)
            })
            // 放在组标题的最前，跟分类头里的折叠箭头观感一致。
            head.insertBefore(toggle, head.firstChild)
          }
        }

        function cardHeadOf(card) {
          const explicit = card.querySelector('[class*="_cardHead"]')
          if (explicit instanceof HTMLElement) return explicit
          for (const child of card.children) {
            if (child instanceof HTMLElement && child.tagName === 'DIV' && child.querySelector('button') !== null) {
              return child
            }
          }
          return null
        }

        /**
         * Writes text only when it differs. Assigning `textContent` always
         * replaces the child text node, which is itself a childList mutation —
         * and this plugin observes childList, so an unconditional write on
         * every sync would re-trigger the observer forever.
         */
        function setText(node, value) {
          if (node.textContent !== value) node.textContent = value
        }
        function setTitle(node, value) {
          if (node.title !== value) node.title = value
        }

        function mountEditButton(section) {
          const head =
            section.querySelector('[class*="_groupHead"]') ??
            (section.firstElementChild instanceof HTMLElement ? section.firstElementChild : null)
          if (head === null) return

          // One button, one mode. Pressing it reveals the inline editor (naming
          // and ordering categories) and the per-card pickers together, and
          // pressing it again puts the page back exactly as the host rendered
          // it — which is also why this must not be a modal: an overlay would
          // cover the very list the mode exists to let the user arrange.
          let toggle = head.querySelector(`[${ATTR.manage}]`)
          if (toggle === null) {
            toggle = document.createElement('button')
            toggle.type = 'button'
            toggle.className = 'dshpc-manage'
            toggle.setAttribute(ATTR.manage, '')
            toggle.addEventListener('click', (event) => {
              event.stopPropagation()
              setEditMode(!editMode)
            })
            head.appendChild(toggle)
          }
          setText(toggle, editMode ? t.finish : t.edit)
          setTitle(toggle, editMode ? t.finishTitle : t.editTitle)
          const pressed = editMode ? 'true' : 'false'
          if (toggle.getAttribute('aria-pressed') !== pressed) toggle.setAttribute('aria-pressed', pressed)
          toggle.classList.toggle('dshpc-manage-on', editMode)
        }

        function setEditMode(next) {
          if (editMode === next) return
          editMode = next
          draftName = ''
          if (!editMode) {
            undo = null
            closePanel()
          }
          scheduleSync()
        }

        function ensureHeader(list, id, name, count, expanded) {
          let node = null
          for (const child of list.children) {
            if (child.getAttribute?.(ATTR.head) === id) {
              node = child
              break
            }
          }
          if (node === null) {
            node = document.createElement('li')
            node.className = 'dshpc-head'
            node.setAttribute(ATTR.head, id)
            node.setAttribute('role', 'button')
            node.setAttribute('tabindex', '0')

            const chevron = document.createElement('span')
            chevron.className = 'dshpc-chevron'
            chevron.setAttribute('aria-hidden', 'true')
            chevron.innerHTML =
              '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>'

            const label = document.createElement('span')
            label.className = 'dshpc-name'

            const badge = document.createElement('span')
            badge.className = 'dshpc-count'

            node.append(chevron, label, badge)
            node.addEventListener('click', (event) => {
              event.stopPropagation()
              toggleCollapsed(id)
            })
            node.addEventListener('keydown', (event) => {
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
              event.preventDefault()
              event.stopPropagation()
              toggleCollapsed(id)
            })
            // Appending is enough: the visual position comes from `style.order`.
            list.appendChild(node)
          }

          const label = node.querySelector('.dshpc-name')
          if (label !== null && label.textContent !== name) label.textContent = name
          const badge = node.querySelector('.dshpc-count')
          const text = t.count(count)
          if (badge !== null && badge.textContent !== text) badge.textContent = text
          const expandedValue = expanded ? 'true' : 'false'
          if (node.getAttribute('aria-expanded') !== expandedValue) node.setAttribute('aria-expanded', expandedValue)
          // While arranging, the group is forced open and the chevron is inert,
          // so it must not advertise a state the user cannot change.
          const hint = editMode ? t.arrangingHint : expanded ? t.collapseHint : t.expandHint
          if (node.title !== hint) node.title = hint
          const inert = editMode ? 'true' : null
          if (node.getAttribute('aria-disabled') !== inert) {
            if (inert === null) node.removeAttribute('aria-disabled')
            else node.setAttribute('aria-disabled', inert)
          }
          return node
        }

        function setCollapsedLook(card, hidden) {
          if (hidden) {
            if (card.style.display !== 'none') card.style.display = 'none'
          } else if (card.style.display === 'none') {
            card.style.removeProperty('display')
          }
        }

        function setOrder(node, order) {
          const value = String(order)
          if (node.style.order !== value) node.style.order = value
        }

        function clearOrder(node) {
          if (node.style.order !== '') node.style.removeProperty('order')
        }

        function mountAssign(card) {
          const head = cardHeadOf(card)
          if (head === null) return
          let select = head.querySelector(`[${ATTR.assign}]`)
          // The picker exists only while the user is arranging the list, and
          // only once there is something to file into, so a normal visit to the
          // page stays exactly as the host rendered it.
          if (!editMode || state.categories.length === 0) {
            if (select !== null) select.remove()
            return
          }
          if (select === null) {
            select = document.createElement('select')
            select.className = 'dshpc-assign'
            select.setAttribute(ATTR.assign, '')
            select.setAttribute('aria-label', t.assignAria)
            select.addEventListener('click', (event) => event.stopPropagation())
            select.addEventListener('pointerdown', (event) => event.stopPropagation())
            select.addEventListener('change', () => {
              const value = select.value
              assign(packageNameOf(card), value === '' ? null : value)
            })
            const end = head.querySelector('[class*="_cardEnd"]')
            if (end instanceof HTMLElement) head.insertBefore(select, end)
            else head.appendChild(select)
          }

          const signature = state.categories.map((entry) => `${entry.id}\u0001${entry.name}`).join('\u0002')
          if (select.getAttribute(ATTR.sig) !== signature) {
            select.setAttribute(ATTR.sig, signature)
            const fragment = document.createDocumentFragment()
            const none = document.createElement('option')
            none.value = ''
            none.textContent = t.uncategorized
            fragment.appendChild(none)
            for (const category of state.categories) {
              const option = document.createElement('option')
              option.value = category.id
              option.textContent = category.name
              fragment.appendChild(option)
            }
            select.replaceChildren(fragment)
          }
          const current = categoryIdOf(packageNameOf(card)) ?? ''
          if (select.value !== current) select.value = current
        }

        // ----------------------------------------------------------------
        // sync: make the DOM match the layout
        // ----------------------------------------------------------------
        function scheduleSync() {
          if (disposed || syncQueued) return
          syncQueued = true
          let frame = null
          let timer = null
          const run = () => {
            if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
            if (timer !== null) clearTimeout(timer)
            frame = null
            timer = null
            syncQueued = false
            sync()
          }
          // A frame callback coalesces bursts nicely, but it is suspended
          // whenever the page is not being painted (background tab, bfcache,
          // headless host). Pair it with a timer and let whichever fires first
          // win, so the list is grouped as soon as the page settles.
          if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run)
          timer = setTimeout(run, 32)
        }

        function sync() {
          if (disposed || syncing) return
          syncing = true
          try {
            syncInner()
          } catch (error) {
            warn('could not lay out the plugin list', error)
          } finally {
            syncing = false
          }
        }

        function syncInner() {
          ensureStyle()

          // 整组折叠：官方 basic / extensions 两组各挂一个独立的折叠开关，
          // 与下方的分类体系完全无关；点哪组就只动哪组。
          for (const groupId of ['basic', 'extensions']) {
            const section = document.querySelector(`section[data-plugin-group="${groupId}"]`)
            if (section === null) continue
            mountGroupCollapse(section, groupId)
            applyGroupCollapsed(section, state.collapsedGroups[groupId] === true)
          }

          const section = groupSection()
          if (section === null) {
            stripInjected()
            return
          }
          const list = cardList(section)
          if (list === null) {
            stripInjected()
            return
          }
          // With no category left there is nothing to file into, so a mode that
          // was left on must not silently come back when one is created again.
          // The editor is the only way to create the first category, so it has
          // to be reachable before any category exists.
          mountEditButton(section)
          renderPanel()

          const cards = packageCards(list)
          const ownerOf = new Map()
          state.categories.forEach((category, index) => {
            for (const name of category.packages) if (!ownerOf.has(name)) ownerOf.set(name, index)
          })

          const groups = state.categories.map((category, index) => ({
            category,
            members: cards.filter((card) => ownerOf.get(packageNameOf(card)) === index),
          }))
          const loose = cards.filter((card) => !ownerOf.has(packageNameOf(card)))

          const wanted = new Set()
          let order = 0

          for (const group of groups) {
            // While the user is arranging the list every card must be reachable,
            // otherwise a collapsed group hides the very pickers needed to move
            // its members out. The stored flag is untouched, so leaving edit mode
            // restores exactly what the user had.
            const collapsed = !editMode && group.category.collapsed === true
            wanted.add(group.category.id)
            const header = ensureHeader(list, group.category.id, group.category.name, group.members.length, !collapsed)
            setOrder(header, order)
            group.members.forEach((card, index) => {
              setOrder(card, order + 1 + index)
              setCollapsedLook(card, collapsed)
              mountAssign(card)
            })
            order += STRIDE
          }

          if (state.categories.length > 0 && loose.length > 0) {
            const collapsed = !editMode && state.uncategorizedCollapsed === true
            wanted.add(UNCAT)
            const header = ensureHeader(list, UNCAT, t.uncategorized, loose.length, !collapsed)
            setOrder(header, order)
            loose.forEach((card, index) => {
              setOrder(card, order + 1 + index)
              setCollapsedLook(card, collapsed)
              mountAssign(card)
            })
            order += STRIDE
          } else {
            // No category at all yet: the host's own order is already correct,
            // so leave the cards untouched rather than rewriting them to match
            // nothing. Only leftovers from a just-deleted category are cleared.
            loose.forEach((card, index) => {
              clearOrder(card)
              setCollapsedLook(card, false)
              mountAssign(card)
              void index
            })
          }

          // Drop headers whose category is gone (deleted, or no loose cards left).
          for (const node of Array.from(list.children)) {
            if (!(node instanceof HTMLElement)) continue
            const id = node.getAttribute(ATTR.head)
            if (id === null || wanted.has(id)) continue
            node.remove()
          }
        }

        function stripInjected() {
          closePanel()
          for (const node of Array.from(document.querySelectorAll(`[${ATTR.head}]`))) node.remove()
          for (const node of Array.from(document.querySelectorAll(`[${ATTR.manage}]`))) node.remove()
          for (const node of Array.from(document.querySelectorAll(`[${ATTR.editor}]`))) node.remove()
          for (const node of Array.from(document.querySelectorAll(`[${ATTR.assign}]`))) node.remove()
          for (const node of Array.from(document.querySelectorAll(`[${ATTR.groupToggle}]`))) node.remove()
          for (const card of Array.from(document.querySelectorAll('li[data-plugin-package]'))) {
            if (card.style.order !== '') card.style.removeProperty('order')
            if (card.style.display === 'none') card.style.removeProperty('display')
          }
        }

        // ----------------------------------------------------------------
        // category editor
        // ----------------------------------------------------------------
        function iconButton(label, glyph, onClick, extraClass) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dshpc-icon' + (extraClass === undefined ? '' : ` ${extraClass}`)
          button.textContent = glyph
          button.title = label
          button.setAttribute('aria-label', label)
          button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          return button
        }

        function categoryRow(category, index) {
          const row = document.createElement('li')
          row.className = 'dshpc-item'

          const input = document.createElement('input')
          input.className = 'dshpc-input'
          input.type = 'text'
          input.maxLength = MAX_NAME
          input.value = category.name
          input.setAttribute('aria-label', t.renameAria)
          input.addEventListener('change', () => renameCategory(category.id, input.value))
          input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            input.blur()
          })

          const count = document.createElement('span')
          count.className = 'dshpc-count'
          count.textContent = t.count(category.packages.length)

          const actions = document.createElement('div')
          actions.className = 'dshpc-actions'
          const up = iconButton(t.up, '↑', () => moveCategory(category.id, -1))
          if (index === 0) up.disabled = true
          const down = iconButton(t.down, '↓', () => moveCategory(category.id, 1))
          if (index === state.categories.length - 1) down.disabled = true
          actions.append(up, down, iconButton(t.remove, '✕', () => deleteCategory(category.id), 'dshpc-danger'))

          row.append(input, count, actions)
          return row
        }

        /**
         * The inline editor, sitting directly above the cards it arranges. It is
         * deliberately part of the list rather than a modal: the user has to
         * click a card's dropdown while the editor is open.
         */
        function ensureEditor(section) {
          let card = section.querySelector(`[${ATTR.editor}]`)
          if (card instanceof HTMLElement) return card
          card = document.createElement('div')
          card.className = 'dshpc-editor'
          card.setAttribute(ATTR.editor, '')
          card.setAttribute('role', 'group')
          card.setAttribute('aria-label', t.panelTitle)
          const list = cardList(section)
          if (list !== null) section.insertBefore(card, list)
          else section.appendChild(card)
          return card
        }

        function closePanel() {
          if (panel === null) return
          panel.remove()
          panel = null
        }

        /**
         * Everything the editor shows, except the half-typed name. Used to skip
         * redundant redraws so the mode does not fight the observer.
         */
        function panelKey() {
          const parts = state.categories.map(
            (category) => `${category.id}\u0001${category.name}\u0001${category.packages.length}`,
          )
          parts.push(offline ? 'offline' : 'online')
          parts.push(undo === null ? 'noun do' : `undo\u0001${undo.category.id}`)
          return parts.join('\u0002')
        }

        function renderPanel() {
          const section = groupSection()
          if (section === null || !editMode) {
            closePanel()
            return
          }
          const card = ensureEditor(section)
          panel = card
          // Rebuilding the editor is itself a DOM change, so a mutation-driven
          // sync would rebuild it again forever. Redraw only when the consulted
          // data actually changed; `draftName` is deliberately not part of the
          // key so typing never reloads the input under the caret.
          const key = panelKey()
          if (card.getAttribute(ATTR.sig) === key) return
          card.setAttribute(ATTR.sig, key)
          card.replaceChildren()

          const title = document.createElement('h3')
          title.className = 'dshpc-title'
          title.textContent = t.panelTitle
          card.appendChild(title)

          const createRow = document.createElement('div')
          createRow.className = 'dshpc-row'
          const input = document.createElement('input')
          input.className = 'dshpc-input'
          input.type = 'text'
          input.maxLength = MAX_NAME
          input.placeholder = t.namePlaceholder
          input.value = draftName
          input.addEventListener('input', () => {
            draftName = input.value
          })
          input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submitDraft()
          })
          const add = document.createElement('button')
          add.type = 'button'
          add.className = 'dshpc-button dshpc-primary'
          add.textContent = t.add
          add.addEventListener('click', () => submitDraft())
          createRow.append(input, add)
          card.appendChild(createRow)

          const list = document.createElement('ul')
          list.className = 'dshpc-list'
          if (state.categories.length === 0) {
            const empty = document.createElement('li')
            empty.className = 'dshpc-empty'
            empty.textContent = t.empty
            list.appendChild(empty)
          } else {
            state.categories.forEach((category, index) => list.appendChild(categoryRow(category, index)))
          }
          card.appendChild(list)

          const hint = document.createElement('p')
          hint.className = 'dshpc-hint'
          hint.textContent = t.hint
          card.appendChild(hint)

          const footer = document.createElement('div')
          footer.className = 'dshpc-footer'
          if (offline) {
            const note = document.createElement('span')
            note.className = 'dshpc-note'
            note.textContent = t.offline
            footer.appendChild(note)
          } else if (undo !== null) {
            const restore = document.createElement('button')
            restore.type = 'button'
            restore.className = 'dshpc-button'
            restore.textContent = t.undo(undo.category.name)
            restore.addEventListener('click', () => {
              restoreDeleted()
              renderPanel()
            })
            footer.appendChild(restore)
          } else {
            const filler = document.createElement('span')
            filler.className = 'dshpc-note'
            footer.appendChild(filler)
          }
          const done = document.createElement('button')
          done.type = 'button'
          done.className = 'dshpc-button dshpc-primary'
          done.textContent = t.done
          done.addEventListener('click', () => setEditMode(false))
          footer.appendChild(done)
          card.appendChild(footer)
        }

        function submitDraft() {
          const category = addCategory(draftName)
          if (category === null) return
          draftName = ''
          // `draftName` is deliberately kept out of the redraw key so typing
          // never rebuilds the box under the caret — which also means the
          // redraw below may be skipped. Clear the live element too, or the
          // name the user just submitted stays in the box.
          const input = panel?.querySelector('.dshpc-row .dshpc-input')
          if (input instanceof HTMLElement) {
            if (input.value !== '') input.value = ''
            input.focus()
          }
          renderPanel()
        }

        // ----------------------------------------------------------------
        // wiring
        // ----------------------------------------------------------------
        function pagePresent() {
          return groupSection() !== null
        }

        function startObserver() {
          if (typeof MutationObserver !== 'function') return
          observer = new MutationObserver(() => {
            if (disposed || !pagePresent()) return
            scheduleSync()
          })
          observer.observe(document.documentElement, { childList: true, subtree: true })
        }

        ensureStyle()
        startObserver()
        // Safety net: a re-render that swaps the list without a childList change
        // we can see (or a page restored from the bfcache) still settles here.
        scanTimer = setInterval(() => {
          if (!disposed && pagePresent()) sync()
        }, 3000)
        void load()
        scheduleSync()

        return () => {
          disposed = true
          observer?.disconnect()
          observer = null
          if (scanTimer !== null) clearInterval(scanTimer)
          scanTimer = null
          if (saveTimer !== null) clearTimeout(saveTimer)
          saveTimer = null
          closePanel()
          stripInjected()
          document.getElementById(STYLE_ID)?.remove()
          void ctx
          void loaded
        }
      },
    }
  },
})
