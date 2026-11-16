window.__ModuleLoader__.load({
  id: '@local/dsh-workflow-zcode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'zcode-workflow'

    /**
     * Surface copy. Kept inline rather than depending on the Client locale
     * service so the panel still renders in a composition without it.
     */
    const zh = {
      'entry.label': '工作流',
      'panel.title': '工作流运行',
      'panel.refresh': '刷新',
      'panel.loading': '读取中…',
      'panel.empty': '还没有运行记录。',
      'panel.emptyHint': '用 run_zcode_workflow 跑一个工作流，结束后完整的执行轨迹会出现在这里。',
      'panel.runs': '运行记录',
      'panel.open': '详情',
      'panel.close': '收起',
      'panel.expand': '展开',
      'panel.collapse': '收起',
      'panel.structured': '结构化',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.input': '任务输入',
      'panel.truncated': '（内容过长，已截断）',
      'panel.result': '结果',
      'panel.error': '错误',
      'panel.primary': '主产物',
      'panel.versionOf': (n) => `v${n}`,
      'panel.resumed': (n) => `续跑 ×${n}`,
      'panel.items': (n) => `${n} 项`,
      'panel.bytes': (n) => `${n} B`,
      'panel.noArtifacts': '这次运行没有发布产物。',
      'panel.emptyArtifact': '暂无数据',
      'panel.worldStep': '工作区命令',
      'panel.worldRead': '工作区读取',
      'panel.worldGroup': '工作区命令',
      'panel.tasks': (n) => `${n} 个任务`,
      'panel.ops': (n) => `${n} 次操作`,
      'panel.maxConcurrency': (n) => `最大并发数 ${n}`,
      'panel.maxConcurrencyLabel': '最大并发数',
      'panel.scope.session': '当前会话',
      'panel.scope.cwd': '当前目录',
      'panel.scope.all': '全部',
      'panel.emptySession': '本会话还没有工作流运行。',
      'panel.configure': '配置',
      'panel.resume': '续跑',
      'panel.delete': '删除记录',
      'panel.apply': '应用',
      'panel.cancel': '取消',
      'panel.configTitle': '运行配置',
      'panel.model': '子代理模型',
      'panel.modelSession': '跟随会话模型',
      'panel.modelUnavailable': '未检测到模型目录服务，仅可使用会话模型。',
      'panel.adjustedAt': '由你调整设置',
      'panel.openSubagent': '查看子代理会话',
      'panel.noSubagentSession': '尚未创建子代理会话',
      'panel.openSubagentFailed': '无法打开该子代理会话',
      'panel.subAgent': 'SubAgent',
      'panel.expandAll': (n) => `展开全部 ${n} 个子代理`,
      'panel.collapseAll': '收起',
      'panel.noRunsInScope': '这个范围里还没有运行记录。',
      'panel.stop': '停止运行',
      'panel.stopping': '停止中…',
      'panel.artifacts': '产物',
      'panel.steps': (settled, total) => `${settled}/${total} 步`,
      'panel.subagents': (n) => `${n} 个子代理`,
      'panel.subagentsWorking': (n) => `${n} 个子代理工作中`,
      'panel.noSubagents': '无子代理',
      'panel.anonymous': '子代理',
      'panel.tokens': (text) => `${text} tokens`,
      'panel.source': (id) => `调整自 run ${id}`,
      'panel.resumedAt': (clock) => `上次续跑 ${clock}`,
      'guide.description': '查看 ZCode 工作流每次运行的阶段、子代理与结果',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.running': '运行中',
      'status.pending': '排队中',
      'status.cancelled': '已取消',
      'phase.pending': '待运行',
      'phase.running': '进行中',
      'phase.completed': '已完成',
      'phase.failed': '失败',
    }

    /** POST one of the plugin's Host routes and unwrap `{ ok, value }`. */
    async function callRoute(path, body) {
      const response = await fetch(`api/dsh-workflow-zcode/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json()
      if (payload?.ok !== true) {
        throw new Error(payload?.error?.message ?? `request failed (${response.status})`)
      }
      return payload.value
    }

    /**
     * Theme tokens with fallbacks.
     *
     * Every surface colour comes from the Host theme: hardcoded greys looked
     * wrong in dark mode and drifted from the rest of the application.
     */
    const T = {
      panelBg: 'var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #ffffff))',
      cardFill: 'var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1, #ffffff))',
      cardFillHover: 'var(--dsw-alias-card-fill-hover, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)))',
      moduleBg: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.07))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.22))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.12))',
      activeBg: 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.13))',
      labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
      labelSecondary: 'var(--dsw-alias-label-secondary, inherit)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, inherit)',
      accent: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4f46e5))',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warning: 'var(--dsw-alias-state-warn-primary, #ea7b14)',
      amberText: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 12px)',
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    }

    const STATUS = {
      completed: { label: zh['status.completed'], dot: T.success },
      failed: { label: zh['status.failed'], dot: T.error },
      running: { label: zh['status.running'], dot: T.warning },
      pending: { label: zh['status.pending'], dot: T.warning },
      cancelled: { label: zh['status.cancelled'], dot: T.labelTertiary },
    }

    const PHASE_STATUS = {
      completed: { label: zh['phase.completed'], color: T.success },
      running: { label: zh['phase.running'], color: T.warning },
      failed: { label: zh['phase.failed'], color: T.error },
      pending: { label: zh['phase.pending'], color: T.labelTertiary },
    }

    /** The Chinese label for a run status, falling back to the raw value. */
    function statusLabel(status) {
      return STATUS[status]?.label ?? String(status ?? '')
    }

    function statusDot(status) {
      return STATUS[status]?.dot ?? T.labelTertiary
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${ms} ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
      return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
    }

    function formatClock(epochMs) {
      if (!Number.isFinite(epochMs)) return ''
      const date = new Date(epochMs)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Compact token count: 94267841 → "94.3M". */
    function formatTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return null
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    /**
     * A node's one-line identity.
     *
     * An ask is addressed to an actor; a workspace step is identified by the
     * command it ran, never by an anonymous subagent name.
     */
    function nodeTitle(node) {
      if (node?.kind === 'world-run' || node?.kind === 'world-read') {
        return node.worldCommand ?? node.instructionsHead ?? zh['panel.worldStep']
      }
      return node?.actorName ?? node?.actorSiteId ?? zh['panel.anonymous']
    }

    function isWorldNode(node) {
      return node?.kind === 'world-run' || node?.kind === 'world-read'
    }

    /** Stable FNV-1a hash so distinct actor names spread across the palette. */
    function hashString(value) {
      const text = String(value ?? '')
      let hash = 2166136261
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    const AVATAR_PALETTE = [
      { bg: '#6366f1', fg: '#ffffff' },
      { bg: '#3b82f6', fg: '#ffffff' },
      { bg: '#ea7b14', fg: '#ffffff' },
      { bg: '#ec4899', fg: '#ffffff' },
      { bg: '#10b981', fg: '#ffffff' },
      { bg: '#ef4444', fg: '#ffffff' },
      { bg: '#8b5cf6', fg: '#ffffff' },
      { bg: '#06b6d4', fg: '#ffffff' },
    ]

    function avatarPalette(name) {
      return AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length]
    }

    /** Inject keyframes and subtle hover helpers once when running in Chromium. */
    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-wf-zcode-css')) return
      const style = document.createElement('style')
      style.id = 'dsh-wf-zcode-css'
      style.textContent = [
        '@keyframes dsh-wf-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        '@keyframes dsh-wf-pulse { 0%, 100% { box-shadow: 0 0 0 3px rgba(234,123,20,0.22); } 50% { box-shadow: 0 0 0 6px rgba(234,123,20,0.06); } }',
        '.dsh-wf-spin { animation: dsh-wf-spin 0.9s linear infinite; }',
        '.dsh-wf-pulse { animation: dsh-wf-pulse 1.8s ease-in-out infinite; }',
        '.dsh-wf-btn:hover:not(:disabled) { background: var(--dsw-alias-card-fill-hover, rgba(127,127,127,0.08)) !important; }',
        '.dsh-wf-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary, inherit) !important; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.07)) !important; }',
        '.dsh-wf-phase:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.04)) !important; }',
        '.dsh-wf-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.12)) !important; }',
        '.dsh-wf-tile:hover { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,0.28)) !important; background: var(--dsw-alias-card-fill-hover, rgba(127,127,127,0.06)) !important; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    const S = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 16px 28px',
        height: '100%', boxSizing: 'border-box', overflowY: 'auto',
        color: T.labelPrimary, fontSize: 13, lineHeight: 1.5,
      },
      headerCard: {
        display: 'flex', flexDirection: 'column', gap: 8, flex: 'none',
        padding: '2px 0 14px', borderBottom: `1px solid ${T.borderSoft}`,
      },
      headerTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      title: {
        fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.35,
        color: T.labelPrimary, flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      button: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        border: `1px solid ${T.border}`, background: T.cardFill, color: T.labelPrimary,
        borderRadius: 7, padding: '4px 10px', fontSize: 12, fontWeight: 500,
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 1.3,
        transition: 'background .12s ease',
      },
      stopButton: {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        border: `1px solid ${T.border}`, background: T.cardFill, color: T.error,
        borderRadius: 7, padding: '4px 10px', fontSize: 12, fontWeight: 500,
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 1.3,
        transition: 'background .12s ease',
      },
      ghostButton: {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        border: 'none', background: 'transparent', color: T.labelTertiary, borderRadius: 6,
        cursor: 'pointer', padding: '3px 6px', fontFamily: 'inherit', fontSize: 11.5,
        transition: 'background .12s ease, color .12s ease',
      },
      metaRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      meta: { color: T.labelTertiary, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' },
      summary: {
        color: T.labelSecondary, fontSize: 12, fontVariantNumeric: 'tabular-nums',
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', lineHeight: 1.5,
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: 'none' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
        padding: '1px 8px', fontSize: 11, background: T.moduleBg,
        color: T.labelSecondary, whiteSpace: 'nowrap',
      },
      switcherWrap: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' },
      switcher: {
        display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start', maxWidth: '100%',
        border: 'none', background: T.moduleBg, borderRadius: 8, padding: '4px 9px',
        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: T.labelSecondary,
        fontSize: 12, transition: 'background .12s ease',
      },
      switcherPopover: {
        display: 'flex', flexDirection: 'column', gap: 2, padding: 4,
        border: `1px solid ${T.borderSoft}`, background: T.panelBg, borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.10)', maxHeight: 260, overflowY: 'auto',
      },
      runRowWrap: {
        display: 'flex', alignItems: 'center', gap: 4, borderRadius: 7, width: '100%', boxSizing: 'border-box',
      },
      runCard: {
        display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left',
        border: '1px solid transparent', background: 'transparent', color: T.labelPrimary,
        borderRadius: 7, padding: '7px 9px', cursor: 'pointer', fontFamily: 'inherit', flex: 1, minWidth: 0,
      },
      runCardActive: { background: T.activeBg },
      runRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      runName: {
        fontWeight: 500, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', flex: 1, minWidth: 0,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      sectionTitle: { fontSize: 12, color: T.labelSecondary, fontWeight: 600 },
      actorGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6,
      },
      actorRow: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
        border: 'none', background: T.moduleBg, borderRadius: 10,
        padding: '6px 10px 6px 7px', cursor: 'pointer', fontFamily: 'inherit', color: T.labelPrimary,
        textAlign: 'left', minWidth: 0, transition: 'background .12s ease',
      },
      dialogBackdrop: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)',
        backdropFilter: 'blur(3px)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 40,
      },
      dialogCard: {
        width: 'min(330px, 92vw)', background: T.panelBg, borderRadius: 12,
        border: `1px solid ${T.borderSoft}`, padding: '16px 18px', display: 'flex',
        flexDirection: 'column', gap: 12, boxShadow: '0 16px 40px rgba(0,0,0,0.22)',
      },
      dialogRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      stepper: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      stepperButton: {
        width: 24, height: 24, borderRadius: 6, border: `1px solid ${T.border}`,
        background: T.moduleBg, color: T.labelPrimary, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
      },
      stepperValue: { minWidth: 28, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: 12.5, fontWeight: 500 },
      select: {
        maxWidth: 190, border: `1px solid ${T.border}`, borderRadius: 7,
        background: T.panelBg, color: T.labelPrimary, fontSize: 11.5, padding: '4px 8px', fontFamily: 'inherit',
      },
      /* station timeline */
      timeline: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 2, flex: 'none' },
      phaseRow: {
        position: 'relative', paddingLeft: 24, paddingTop: 6, paddingBottom: 6, minHeight: 34,
        borderRadius: 8, transition: 'background .12s ease',
      },
      lamp: {
        position: 'absolute', left: 4, top: 13, width: 10, height: 10, borderRadius: '50%',
        background: T.labelTertiary, boxSizing: 'border-box', zIndex: 2,
      },
      phaseButton: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0, minHeight: 24,
        border: 'none', background: 'transparent', color: T.labelPrimary,
        padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
      },
      phaseTitleWrap: { display: 'flex', alignItems: 'baseline', gap: 6, flex: 1, minWidth: 0 },
      phaseId: { fontFamily: T.mono, fontSize: 10, color: T.labelTertiary, flex: 'none' },
      phaseTitle: {
        fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', lineHeight: 1.4,
      },
      phaseRight: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
      fraction: { fontSize: 11.5, color: T.labelTertiary, fontVariantNumeric: 'tabular-nums' },
      chevron: { fontSize: 9, color: T.labelTertiary, width: 9, textAlign: 'center' },
      roleList: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, paddingBottom: 4 },
      roleRow: { display: 'flex', flexDirection: 'column', gap: 6 },
      rolePill: {
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', boxSizing: 'border-box',
        border: 'none', background: T.moduleBg,
        borderRadius: 999, padding: '5px 12px 5px 7px', minHeight: 34,
        cursor: 'pointer', fontFamily: 'inherit', color: T.labelPrimary,
        textAlign: 'left', minWidth: 0, transition: 'background .12s ease',
      },
      roleName: {
        fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      roleMeta: { fontSize: 11.5, color: T.labelTertiary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      roleState: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
      nodeList: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, paddingTop: 2 },
      /* nodes */
      node: {
        border: `1px solid ${T.borderSoft}`, background: T.cardFill,
        borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
      },
      nodeHead: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      nodeName: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      command: {
        fontFamily: T.mono, fontSize: 11, color: T.labelSecondary, background: T.moduleBg,
        borderRadius: T.radiusSm, padding: '4px 8px', overflowX: 'auto', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      label: { fontSize: 10.5, color: T.labelTertiary },
      body: {
        fontFamily: T.mono, fontSize: 11, color: T.labelSecondary, whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', margin: 0, maxHeight: 240, overflow: 'auto',
      },
      error: {
        fontSize: 11.5, color: T.error, background: 'rgba(220,38,38,0.06)',
        border: '1px solid rgba(220,38,38,0.20)', borderRadius: 8, padding: '6px 10px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      tag: {
        fontSize: 10, color: T.labelTertiary, background: T.moduleBg,
        border: `1px solid ${T.borderSoft}`, borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap',
      },
      tagPrimary: { borderColor: T.accent, color: T.accent, background: 'transparent' },
      /* artifacts */
      artifactSection: {
        display: 'flex', flexDirection: 'column', gap: 8,
        paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`,
      },
      artifactGrid: {
        display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))',
      },
      tile: {
        display: 'flex', flexDirection: 'column', border: `1px solid ${T.borderSoft}`,
        background: T.cardFill, borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
        fontFamily: 'inherit', color: T.labelPrimary, textAlign: 'left', padding: 0, minWidth: 0,
        transition: 'border-color .12s ease, background .12s ease',
      },
      tileActive: { borderColor: T.accent },
      preview: {
        minHeight: 72, padding: '9px 10px', background: T.moduleBg,
        display: 'flex', flexDirection: 'column', gap: 5, justifyContent: 'center',
      },
      emptyBox: {
        border: `1px dashed ${T.border}`, borderRadius: 8, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: T.labelTertiary, fontSize: 11,
      },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
      chip: {
        display: 'inline-flex', alignItems: 'baseline', gap: 4, background: T.panelBg,
        border: `1px solid ${T.borderSoft}`, borderRadius: 999, padding: '1px 7px',
        fontSize: 10, color: T.labelSecondary, whiteSpace: 'nowrap',
      },
      chipValue: { fontWeight: 600, color: T.labelPrimary, fontVariantNumeric: 'tabular-nums' },
      tileFoot: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px',
        borderTop: `1px solid ${T.borderSoft}`, minWidth: 0,
      },
      tileTitle: {
        fontSize: 11.5, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      artifactDetail: {
        border: `1px solid ${T.border}`, background: T.cardFill, borderRadius: 10,
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7,
      },
      footerButton: {
        display: 'flex', alignItems: 'center', gap: 8, border: 'none',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
        fontFamily: 'inherit', borderRadius: 6,
      },
      footerButtonWide: { width: '100%', padding: '6px 8px', justifyContent: 'flex-start' },
      footerButtonRail: { padding: 6, justifyContent: 'center' },
      footerLabel: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }

    /* ---------------------------------------------------------------- atoms */

    function StatusPill({ status }) {
      return h('span', { style: S.pill }, [
        h('span', { key: 'd', style: { ...S.dot, background: statusDot(status) } }),
        h('span', { key: 'l' }, statusLabel(status)),
      ])
    }

    /** Copy button that reports its own success, so the click is visible. */
    function CopyButton({ text }) {
      const [copied, setCopied] = useState(false)
      const copy = useCallback(() => {
        const value = typeof text === 'string' ? text : ''
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }
        try {
          if (navigator?.clipboard?.writeText !== undefined) {
            navigator.clipboard.writeText(value).then(done, () => {})
            return
          }
        } catch {
          // fall through to the legacy path
        }
        try {
          const area = document.createElement('textarea')
          area.value = value
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          done()
        } catch {
          // nothing else to try
        }
      }, [text])
      return h('button', {
        type: 'button',
        style: S.ghostButton,
        onClick: copy,
        title: zh['panel.copy'],
        'aria-label': zh['panel.copy'],
      }, copied ? zh['panel.copied'] : zh['panel.copy'])
    }

    function IconSliders({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': 'true',
        style: { flex: 'none' },
      }, [
        h('path', { key: 'l1', d: 'M2.5 4.5 H13.5' }),
        h('circle', { key: 'c1', cx: 6, cy: 4.5, r: 1.6, fill: T.panelBg }),
        h('path', { key: 'l2', d: 'M2.5 11.5 H13.5' }),
        h('circle', { key: 'c2', cx: 10.5, cy: 11.5, r: 1.6, fill: T.panelBg }),
      ])
    }

    function IconRotateCw({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.4-3.55' }),
        h('path', { key: 'b', d: 'M13.5 2.4v2.9h-2.9' }),
      ])
    }

    function IconStopSquare({ size = 10 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'currentColor',
        'aria-hidden': 'true', style: { flex: 'none' },
      }, h('rect', { x: 2, y: 2, width: 8, height: 8, rx: 1.8 }))
    }

    function IconSummaryList({ size = 13 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: T.labelTertiary, strokeWidth: 1.4, strokeLinecap: 'round',
        'aria-hidden': 'true', style: { flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M2.5 4.5h8.5' }),
        h('path', { key: 'b', d: 'M2.5 8h11' }),
        h('path', { key: 'c', d: 'M2.5 11.5h6.5' }),
      ])
    }

    function IconSpinner({ size = 13, color = T.labelTertiary }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        className: 'dsh-wf-spin', 'aria-hidden': 'true', style: { flex: 'none' },
      }, [
        h('circle', { key: 'track', cx: 8, cy: 8, r: 5.5, stroke: color, strokeWidth: 1.6, opacity: 0.22 }),
        h('path', { key: 'arc', d: 'M8 2.5A5.5 5.5 0 0 1 13.5 8', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' }),
      ])
    }

    function IconCrossSmall({ size = 12, color = T.error }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': 'true', style: { flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M3.2 3.2L8.8 8.8' }),
        h('path', { key: 'b', d: 'M8.8 3.2L3.2 8.8' }),
      ])
    }

    function IconArrowUpRight({ size = 11 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { flex: 'none', opacity: 0.6 },
      }, [
        h('path', { key: 'a', d: 'M3.5 8.5L8.5 3.5' }),
        h('path', { key: 'b', d: 'M4.5 3.5h4v4' }),
      ])
    }

    function IconTrash({ size = 12 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M2.8 4.5h10.4' }),
        h('path', { key: 'b', d: 'M6 4.5V3.1c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.4' }),
        h('path', { key: 'c', d: 'M4.3 4.5l.7 8.1c0 .6.5 1.1 1.1 1.1h3.8c.6 0 1.1-.5 1.1-1.1l.7-8.1' }),
      ])
    }

    /** A rounded-square robot avatar; colour is stable per actor name. */
    function Avatar({ name, size = 20, state }) {
      const palette = avatarPalette(name)
      const badgeHalo = `0 0 0 1.5px ${T.panelBg}`
      return h('span', {
        style: { position: 'relative', display: 'inline-flex', flex: 'none', width: size, height: size },
        title: name ?? '',
      }, [
        h('svg', {
          key: 'bot',
          width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
          style: { display: 'block' },
        }, [
          h('rect', { key: 'bg', x: 1, y: 1, width: 22, height: 22, rx: 7, fill: palette.bg }),
          h('rect', { key: 'neck', x: 11.2, y: 4.5, width: 1.6, height: 3, rx: 0.8, fill: palette.fg, opacity: 0.85 }),
          h('circle', { key: 'ant', cx: 12, cy: 4.2, r: 1.15, fill: palette.fg, opacity: 0.92 }),
          h('rect', { key: 'head', x: 5.5, y: 8.2, width: 13, height: 9, rx: 4.2, fill: palette.fg }),
          h('circle', { key: 'e1', cx: 9.7, cy: 12.7, r: 1.25, fill: palette.bg }),
          h('circle', { key: 'e2', cx: 14.3, cy: 12.7, r: 1.25, fill: palette.bg }),
        ]),
        state === 'completed'
          ? h('span', {
            key: 'check',
            style: {
              position: 'absolute', right: -2, bottom: -2, width: 9, height: 9, borderRadius: '50%',
              background: T.success, display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: badgeHalo,
            },
          }, h('svg', { width: 6, height: 6, viewBox: '0 0 8 8' },
            h('path', { d: 'M1.4 4.1 L3.1 5.8 L6.6 2.1', stroke: '#fff', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' })))
          : state === 'running'
            ? h('span', {
              key: 'run',
              style: {
                position: 'absolute', right: -2, bottom: -2, width: 8, height: 8, borderRadius: '50%',
                background: T.warning, boxShadow: badgeHalo,
              },
              'data-avatar-state': 'running',
            })
            : state === 'failed'
              ? h('span', {
                key: 'fail',
                style: {
                  position: 'absolute', right: -2, bottom: -2, width: 9, height: 9, borderRadius: '50%',
                  background: T.error, color: '#fff', fontSize: 7, fontWeight: 700, lineHeight: '9px', textAlign: 'center',
                  boxShadow: badgeHalo,
                },
                'data-avatar-state': 'failed',
              }, '×')
              : null,
      ])
    }

    /** Dark terminal badge for workspace operations. */
    function WorldBadge({ size = 20 }) {
      return h('span', {
        style: {
          position: 'relative',
          width: size, height: size, borderRadius: Math.round(size * 0.29), flex: 'none',
          background: '#272a30', color: '#f4f4f5',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: T.mono, fontSize: Math.round(size * 0.42), fontWeight: 600, letterSpacing: '-0.5px',
        },
        title: zh['panel.worldGroup'],
        'aria-label': zh['panel.worldGroup'],
      }, '>_')
    }

    /** Overlapping avatar cluster, at most `max` plus a +N chip. */
    function AvatarCluster({ roles, max = 3 }) {
      const list = Array.isArray(roles) ? roles : []
      if (list.length === 0) return null
      const shown = list.slice(0, max)
      const rest = list.length - shown.length
      const hasWorld = list.some((role) => role.kind === 'world')
      const haloStyle = (index) => ({
        position: 'relative',
        zIndex: index + 1,
        marginLeft: index === 0 ? 0 : -4,
        display: 'inline-flex',
        borderRadius: 6,
        boxShadow: `0 0 0 1.5px ${T.panelBg}`,
        background: T.panelBg,
      })
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 0 }, 'data-testid': 'avatar-cluster' }, [
        ...shown.map((role, index) => h('span', {
          key: `a${index}`,
          style: haloStyle(index),
        }, role.kind === 'world'
          ? h(WorldBadge, { size: 18 })
          : h(Avatar, { name: role.name ?? role.siteId, size: 18, state: role.state }))),
        ...(hasWorld && !shown.some((role) => role.kind === 'world')
          ? [h('span', { key: 'w', style: haloStyle(shown.length) }, h(WorldBadge, { size: 18 }))]
          : []),
        rest > 0 ? h('span', { key: 'rest', style: { ...S.fraction, marginLeft: 6 } }, `+${rest}`) : null,
      ].filter(Boolean))
    }

    /** A small SVG chevron; text glyphs vary too much between UI fonts. */
    function Chevron({ open, size = 10, color = T.labelTertiary }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', transform: open === true ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' },
      }, h('path', { d: 'M4.5 2.5 L8 6 L4.5 9.5' }))
    }

    function KindIcon({ kind, size = 13 }) {
      const common = {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { flex: 'none', color: T.labelTertiary },
      }
      if (kind === 'chart') {
        return h('svg', common, [
          h('path', { key: 'a', d: 'M2.5 13.5 V9' }), h('path', { key: 'b', d: 'M6.5 13.5 V6' }),
          h('path', { key: 'c', d: 'M10.5 13.5 V8' }), h('path', { key: 'd', d: 'M14 13.5 V3.5' }),
        ])
      }
      if (kind === 'table') {
        return h('svg', common, [
          h('rect', { key: 'r', x: 2, y: 3, width: 12, height: 10, rx: 1.5 }),
          h('path', { key: 'h', d: 'M2 6.5 H14' }), h('path', { key: 'v', d: 'M6.5 6.5 V13' }),
        ])
      }
      if (kind === 'metrics') {
        return h('svg', common, [
          h('path', { key: 'a', d: 'M2.5 12.5 a5.5 5.5 0 0 1 11 0' }),
          h('path', { key: 'b', d: 'M8 12.5 L11 8.5' }),
        ])
      }
      if (kind === 'board') {
        return h('svg', common, [
          h('rect', { key: 'a', x: 2, y: 2.5, width: 5, height: 5, rx: 1 }),
          h('rect', { key: 'b', x: 9, y: 2.5, width: 5, height: 3, rx: 1 }),
          h('rect', { key: 'c', x: 2, y: 9.5, width: 5, height: 4, rx: 1 }),
          h('rect', { key: 'd', x: 9, y: 7.5, width: 5, height: 6, rx: 1 }),
        ])
      }
      if (kind === 'markdown') {
        return h('svg', common, [
          h('rect', { key: 'r', x: 3, y: 2, width: 10, height: 12, rx: 1.5 }),
          h('path', { key: 'a', d: 'M5.5 5.5 H10.5' }), h('path', { key: 'b', d: 'M5.5 8 H10.5' }),
          h('path', { key: 'c', d: 'M5.5 10.5 H8.5' }),
        ])
      }
      return h('svg', common, [
        h('path', { key: 'f', d: 'M3.5 1.8 h6 l3 3 v9.4 h-9 z' }),
        h('path', { key: 'c', d: 'M9.5 1.8 v3 h3' }),
      ])
    }

    /* ---------------------------------------------------------------- nodes */

    function NodeCard({ node, defaultOpen = false }) {
      const [open, setOpen] = useState(defaultOpen)
      const world = isWorldNode(node)
      const lamp = node.state === 'failed' ? T.error : node.state === 'running' ? T.warning : T.success
      const hasDetail = node.instructions !== '' || node.result !== undefined || node.error !== undefined
      return h('div', { style: S.node, 'data-node-kind': node.kind ?? 'ask' }, [
        h('div', { key: 'head', style: S.nodeHead }, [
          h('span', { key: 'lamp', style: { ...S.dot, background: lamp } }),
          world
            ? h(WorldBadge, { key: 'w', size: 15 })
            : h(Avatar, { key: 'av', name: node.actorName ?? node.actorSiteId ?? '?', size: 15, state: node.state }),
          h('span', { key: 'name', style: S.nodeName }, world ? (node.worldCommand ?? zh['panel.worldStep']) : (node.actorName ?? zh['panel.anonymous'])),
          !world ? h('span', { key: 'site', style: S.tag }, node.siteId) : null,
          node.typed ? h('span', { key: 'typed', style: S.tag }, zh['panel.structured']) : null,
          h('span', { key: 'dur', style: { ...S.meta, marginLeft: 'auto' } }, formatDuration(node.durationMs)),
          hasDetail ? h('button', {
            key: 'toggle',
            type: 'button',
            style: S.ghostButton,
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            'data-testid': 'node-toggle',
          }, open ? zh['panel.close'] : zh['panel.open']) : null,
        ].filter(Boolean)),

        // The task input and the outcome are separate blocks: mixing them is
        // what made the old card unreadable.
        open && node.instructions !== ''
          ? h('div', { key: 'in' }, [
            h('div', { key: 'l', style: S.label }, zh['panel.input']),
            h('p', { key: 'b', style: S.body }, node.instructions),
            node.instructionsTruncated === true
              ? h('div', { key: 't', style: S.label }, zh['panel.truncated'])
              : null,
          ])
          : null,
        open && node.result !== undefined
          ? h('div', { key: 'out' }, [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h('span', { key: 'l', style: S.label }, zh['panel.result']),
              h(CopyButton, { key: 'c', text: node.result }),
            ]),
            h('pre', { key: 'b', style: S.body }, node.result),
          ])
          : null,
        // Collapsed, a settled node still hints at its answer.
        !open && node.resultPreview !== undefined && node.state !== 'failed'
          ? h('pre', { key: 'preview', style: { ...S.body, maxHeight: 32, overflow: 'hidden', opacity: 0.7 } }, node.resultPreview)
          : null,
        node.error !== undefined
          ? h('div', { key: 'err', style: S.error }, node.error)
          : null,
      ].filter(Boolean))
    }

    /* ------------------------------------------------------------- artifacts */

    const EMPTY_ARTIFACT = (artifact) => {
      const reports = Array.isArray(artifact?.reports) ? artifact.reports : []
      const hasBody = typeof artifact?.body === 'string' && artifact.body.trim() !== ''
      const count = Number(artifact?.itemCount ?? 0)
      return reports.length === 0 && !hasBody && count === 0
    }

    /** Metric chips from `reports` (or `spec.metrics` when no reports exist). */
    function metricChips(artifact) {
      const chips = []
      const push = (label, value) => {
        if (chips.length >= 4) return
        if (label === undefined || label === null || label === '') return
        chips.push({ label: String(label), value: value === undefined || value === null ? '—' : String(value) })
      }
      const reports = Array.isArray(artifact.reports) ? artifact.reports : []
      for (const report of reports) {
        const item = report?.item
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const label = item.label ?? item.name ?? item.title ?? item.key
          const value = item.value ?? item.count ?? item.n ?? item.total
          if (label !== undefined) push(label, value)
          else for (const [key, entry] of Object.entries(item).slice(0, 2)) push(key, entry)
        } else if (Array.isArray(item)) {
          for (const entry of item.slice(0, 2)) {
            if (entry !== null && typeof entry === 'object') {
              const label = entry.label ?? entry.name ?? entry.title ?? entry.key
              push(label, entry.value ?? entry.count ?? entry.n)
            }
          }
        }
      }
      if (chips.length === 0 && Array.isArray(artifact.spec?.metrics)) {
        for (const metric of artifact.spec.metrics) {
          push(metric?.label ?? metric?.name ?? metric?.key, metric?.value ?? metric?.count)
        }
      }
      return chips
    }

    /** First rows of a `table` spec (or of its reports). */
    function tablePreview(artifact) {
      const spec = artifact.spec ?? {}
      const columns = Array.isArray(spec.columns) ? spec.columns.map((c) => (typeof c === 'string' ? c : (c?.label ?? c?.name ?? c?.key ?? ''))) : []
      let rows = Array.isArray(spec.rows) ? spec.rows : null
      if (rows === null) {
        const reports = Array.isArray(artifact.reports) ? artifact.reports : []
        rows = reports.map((report) => {
          const item = report?.item
          if (Array.isArray(item)) return item
          if (item !== null && typeof item === 'object') return columns.length > 0 ? columns.map((key) => item[key]) : Object.values(item)
          return [item]
        })
      }
      return { columns: columns.slice(0, 4), rows: rows.slice(0, 2) }
    }

    /** Mini bar preview from `spec.data` / `spec.series`. */
    function chartBars(artifact) {
      const spec = artifact.spec ?? {}
      const data = Array.isArray(spec.data) ? spec.data : (Array.isArray(spec.series) ? spec.series : [])
      const values = data.map((entry) => Number(entry?.value ?? entry?.count ?? 0)).filter((n) => Number.isFinite(n))
      return values.slice(0, 6)
    }

    /** 2–3 line excerpt for markdown / file previews. */
    function textExcerpt(artifact) {
      if (typeof artifact.body === 'string' && artifact.body.trim() !== '') {
        return artifact.body.split('\n').map((line) => line.replace(/^#{1,6}\s*/, '').trim()).filter((line) => line !== '').slice(0, 3)
      }
      if (typeof artifact.sourcePath === 'string') return [artifact.sourcePath]
      return []
    }

    function ArtifactPreview({ artifact }) {
      if (EMPTY_ARTIFACT(artifact)) {
        return h('div', { style: S.emptyBox, 'data-testid': 'artifact-empty' }, zh['panel.emptyArtifact'])
      }
      const kind = artifact.kind
      if (kind === 'metrics' || kind === 'board') {
        const chips = metricChips(artifact)
        if (chips.length > 0) {
          return h('div', { style: S.chipRow }, chips.map((chip, index) => h('span', {
            key: `c${index}`, style: S.chip,
          }, [chip.label, h('span', { key: 'v', style: S.chipValue }, chip.value)])))
        }
      }
      if (kind === 'table') {
        const { columns, rows } = tablePreview(artifact)
        if (rows.length > 0) {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 9.5 } }, [
            columns.length > 0
              ? h('div', { key: 'h', style: { display: 'flex', gap: 6, color: T.labelTertiary } },
                columns.map((column, index) => h('span', { key: `h${index}`, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, column)))
              : null,
            ...rows.map((row, index) => h('div', { key: `r${index}`, style: { display: 'flex', gap: 6, fontVariantNumeric: 'tabular-nums' } },
              (Array.isArray(row) ? row : [row]).slice(0, 4).map((cell, cellIndex) => h('span', {
                key: `c${cellIndex}`, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, String(cell ?? ''))))),
          ].filter(Boolean))
        }
      }
      if (kind === 'chart') {
        const values = chartBars(artifact)
        if (values.length > 0) {
          const max = Math.max(...values, 1)
          return h('svg', { width: '100%', height: 40, viewBox: '0 0 100 40', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, values.map((value, index) => {
            const width = 100 / values.length
            const height = Math.max(3, (value / max) * 32)
            return h('rect', {
              key: `b${index}`, x: index * width + width * 0.15, y: 36 - height,
              width: width * 0.7, height, rx: 1.5, fill: T.accent, opacity: 0.55 + 0.12 * index,
            })
          }))
        }
      }
      const lines = textExcerpt(artifact)
      if (lines.length > 0) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, fontSize: 9.8, color: T.labelSecondary } },
          lines.map((line, index) => h('div', {
            key: `l${index}`,
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 1 - index * 0.2 },
          }, line)))
      }
      return h('div', { style: S.emptyBox }, zh['panel.emptyArtifact'])
    }

    function artifactFootMeta(artifact) {
      const reports = Array.isArray(artifact.reports) ? artifact.reports.length : 0
      if (reports > 0) return zh['panel.items'](reports)
      if (artifact.kind === 'file' && Number.isFinite(Number(artifact.itemCount))) return zh['panel.bytes'](Number(artifact.itemCount))
      if (Number.isFinite(Number(artifact.version))) return zh['panel.versionOf'](Number(artifact.version))
      return ''
    }

    function ArtifactTile({ artifact, active, onOpen }) {
      return h('button', {
        type: 'button',
        className: 'dsh-wf-tile',
        style: { ...S.tile, ...(active ? S.tileActive : {}) },
        onClick: () => onOpen(artifact.id),
        'data-artifact-id': artifact.id,
        'data-artifact-kind': artifact.kind,
        'aria-expanded': active === true,
      }, [
        h('div', { key: 'preview', style: S.preview }, h(ArtifactPreview, { artifact })),
        h('div', { key: 'foot', style: S.tileFoot }, [
          h(KindIcon, { key: 'icon', kind: artifact.kind }),
          h('span', { key: 'title', style: S.tileTitle }, artifact.title ?? artifact.id),
          artifact.primary === true
            ? h('span', { key: 'p', style: { ...S.tag, ...S.tagPrimary } }, zh['panel.primary'])
            : null,
          h('span', { key: 'meta', style: S.fraction }, artifactFootMeta(artifact)),
        ].filter(Boolean)),
      ])
    }

    /** Expanded artifact: full body / path / every report item. */
    function ArtifactCard({ artifact, reports }) {
      const list = Array.isArray(reports) ? reports : (Array.isArray(artifact.reports) ? artifact.reports : [])
      return h('div', { style: S.artifactDetail, 'data-artifact-id': artifact.id }, [
        h('div', { key: 'head', style: S.nodeHead }, [
          h(KindIcon, { key: 'icon', kind: artifact.kind }),
          h('span', { key: 'id', style: { ...S.nodeName, flex: 'none' } }, artifact.id),
          h('span', { key: 'kind', style: S.tag }, String(artifact.kind ?? '')),
          artifact.primary === true
            ? h('span', { key: 'primary', style: { ...S.tag, ...S.tagPrimary } }, zh['panel.primary'])
            : null,
          Number.isFinite(Number(artifact.version))
            ? h('span', { key: 'v', style: S.fraction }, zh['panel.versionOf'](Number(artifact.version)))
            : null,
        ].filter(Boolean)),
        artifact.description !== undefined
          ? h('div', { key: 'desc', style: S.meta }, artifact.description)
          : null,
        artifact.sourcePath !== undefined
          ? h('div', { key: 'path', style: S.command }, artifact.sourcePath)
          : null,
        typeof artifact.body === 'string'
          ? h('pre', { key: 'body', style: S.body }, artifact.body)
          : null,
        list.length > 0
          ? h('pre', { key: 'reports', style: S.body }, JSON.stringify(list.map((report) => report.item), null, 2))
          : null,
      ].filter(Boolean))
    }

    /* ------------------------------------------------------------------ runs */

    function RunCard({ run, active, onSelect, onDelete }) {
      const settled = run.status !== 'running' && run.status !== 'pending'
      return h('div', {
        style: { ...S.runRowWrap, ...(active ? S.runCardActive : {}) },
        'data-run-id': run.runId,
      }, [
        h('button', {
          key: 'sel',
          type: 'button',
          className: 'dsh-wf-ghost',
          style: S.runCard,
          onClick: () => onSelect(run.runId),
          'aria-pressed': active,
        }, [
          h('div', { key: 'top', style: S.runRow }, [
            h('span', { key: 'dot', style: { ...S.dot, background: statusDot(run.status) } }),
            h('span', { key: 'name', style: S.runName }, run.workflowId),
            run.resumeCount > 0
              ? h('span', { key: 'resumed', style: S.tag }, zh['panel.resumed'](run.resumeCount))
              : null,
            h('span', { key: 'dur', style: S.meta }, formatDuration(run.durationMs)),
          ].filter(Boolean)),
          h('div', { key: 'meta', style: { ...S.runRow, ...S.meta, gap: 8 } }, [
            h('span', { key: 'status' }, statusLabel(run.status)),
            h('span', { key: 'time' }, formatClock(run.startedAt)),
            run.nodes !== undefined ? h('span', { key: 'calls' }, `${run.nodes} 次调用`) : null,
          ].filter(Boolean)),
          run.failure !== undefined
            ? h('div', { key: 'fail', style: { ...S.meta, color: T.error, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, run.failure)
            : null,
        ].filter(Boolean)),
        typeof onDelete === 'function' && settled
          ? h('button', {
            key: 'del',
            type: 'button',
            className: 'dsh-wf-ghost',
            style: { ...S.ghostButton, padding: '6px', marginRight: 4, flex: 'none', color: T.labelTertiary },
            onClick: (event) => {
              event?.stopPropagation?.()
              onDelete(run.runId)
            },
            title: zh['panel.delete'],
            'aria-label': zh['panel.delete'],
            'data-run-delete': run.runId,
          }, h(IconTrash, { size: 12 }))
          : null,
      ].filter(Boolean))
    }

    /** Compact runs picker: one sleek pill, history opens on demand. */
    function RunSwitcher({ runs, selectedId, onSelect, onDelete }) {
      const [open, setOpen] = useState(false)
      const current = runs.find((run) => run.runId === selectedId) ?? runs[0]
      if (current === undefined) return null
      return h('div', { style: S.switcherWrap }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsh-wf-pill',
          style: S.switcher,
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
          'data-testid': 'run-switcher',
        }, [
          h('span', { key: 'dot', style: { ...S.dot, background: statusDot(current.status) } }),
          h('span', { key: 'name', style: S.runName }, current.workflowId),
          h('span', {
            key: 'count',
            style: { ...S.meta, fontSize: 10.5, background: T.panelBg, borderRadius: 999, padding: '0 6px' },
          }, `${runs.length} 次`),
          h(Chevron, { key: 'chev', open, size: 9 }),
        ].filter(Boolean)),
        open
          ? h('div', { key: 'list', style: S.switcherPopover },
            runs.map((run) => h(RunCard, {
              key: run.runId,
              run,
              active: run.runId === current.runId,
              onSelect: (id) => {
                setOpen(false)
                onSelect(id)
              },
              onDelete,
            })))
          : null,
      ].filter(Boolean))
    }

    /* ---------------------------------------------------------- host bridge */

    /** The narrowest usable scope: a session panel defaults to its own session. */
    function defaultScopeFor(sessionId) {
      return typeof sessionId === 'string' && sessionId !== '' ? 'session' : 'all'
    }

    /**
     * The `/runs` body for one scope. The critical invariant: a session scope
     * NEVER degrades into an empty body (= every run on the machine); it either
     * names the session or, without one, the page starts in the all scope.
     */
    function runsQueryFor(scope, sessionId, cwd) {
      if (scope === 'session' && typeof sessionId === 'string' && sessionId !== '') return { sessionId }
      if (scope === 'cwd' && typeof cwd === 'string' && cwd !== '') return { cwd }
      return {}
    }


    /**
     * The cwd of a session, read defensively from whichever shape this
     * Harness exposes. The panel only needs it for the "current directory"
     * filter; a missing value simply hides that scope option.
     */
    function resolveSessionCwd(ctx, sessionId) {
      if (sessionId === undefined) return undefined
      try {
        const sessions = ctx?.get?.('sessions')
        const list = sessions?.list
        const raw = typeof list === 'function' ? list() : list
        const snapshot = raw?.getSnapshot?.() ?? raw?.state ?? raw
        const rows = snapshot?.byId ?? snapshot?.sessions ?? (Array.isArray(snapshot) ? snapshot : undefined)
        const row = Array.isArray(rows)
          ? rows.find((entry) => (entry?.id ?? entry?.sessionId) === sessionId)
          : rows?.[sessionId]
        const cwd = row?.cwd ?? row?.workingDirectory ?? row?.directory
        if (typeof cwd === 'string' && cwd !== '') return cwd
        if (typeof snapshot?.cwd === 'string' && snapshot.cwd !== '') return snapshot.cwd
      } catch {
        // a composition without a session store simply has no cwd filter
      }
      return undefined
    }

    /**
     * The session this page belongs to when the Host did not pass one (the full
     * page slot). Mirrors the AgentTeams fallback: `currentSessionId`, then the
     * row retained by the main view.
     */
    function currentSessionIdFrom(ctx) {
      try {
        const sessions = ctx?.get?.('sessions')
        const list = sessions?.list
        const raw = typeof list === 'function' ? list() : list
        const snapshot = raw?.getSnapshot?.() ?? raw?.state ?? raw
        const direct = snapshot?.currentSessionId ?? snapshot?.current
        if (typeof direct === 'string' && direct !== '') return direct
        const rows = snapshot?.byId ?? snapshot?.sessions ?? (Array.isArray(snapshot) ? snapshot : undefined)
        if (Array.isArray(rows)) {
          const retained = rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)
          if (typeof retained?.id === 'string') return retained.id
        } else if (rows !== null && typeof rows === 'object') {
          const retained = Object.values(rows).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)
          if (typeof retained?.id === 'string') return retained.id
        }
      } catch {
        // no session store: the page falls back to the all scope
      }
      return undefined
    }

    /** Available subagent models from the harness model directory, when present. */
    function readModelOptions(ctx, sessionId) {
      const options = [{ value: 'session', label: zh['panel.modelSession'] }]
      try {
        const directory = ctx?.get?.('modelDirectories')?.directoryFor?.(sessionId)
        const snapshot = directory?.store?.getSnapshot?.()
        for (const group of snapshot?.groups ?? []) {
          for (const model of group?.models ?? []) {
            const id = model?.id ?? model?.model
            if (typeof id !== 'string' || id === '') continue
            options.push({
              value: `${group.id}/${id}`,
              label: `${group.name ?? group.id} / ${model.name ?? id}`,
            })
          }
        }
      } catch {
        // fall through with the session-model option only
      }
      return options
    }

    /**
     * Open one subagent transcript, following the same version-tolerant path the
     * AgentTeams panel uses: refresh the parent's catalog, then address the
     * child exactly; older Harnesses fall back to opening the plain session.
     */
    async function openSubagentSession(services, parentSessionId, childSessionId) {
      const { sessions, layout, workspace } = services ?? {}
      try {
        if (typeof sessions?.open !== 'function' && typeof workspace?.openSession === 'function') {
          workspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })
          return 'subagent'
        }
        const navigation = layout?.beginNavigation?.()
        if (typeof sessions?.openSubagent !== 'function' || typeof sessions?.refreshSubagents !== 'function') {
          if (typeof sessions?.open !== 'function') return false
          sessions.open(childSessionId)
          layout?.selectPanel?.(null)
          return 'session'
        }
        await sessions.refreshSubagents(parentSessionId)
        if (navigation?.aborted === true) return 'cancelled'
        const retained = sessions.subagentAddress?.(childSessionId)
        sessions.openSubagent(retained?.parentSessionId === parentSessionId
          ? retained
          : { parentSessionId, childSessionId, mode: 'continuable' })
        layout?.selectPanel?.(null)
        return 'subagent'
      } catch {
        return false
      }
    }

    /** Merge each actor's per-phase role state into one overall state. */
    function actorStatesOf(trace) {
      const states = new Map()
      const rank = { failed: 3, running: 2, completed: 1, pending: 0 }
      for (const phase of trace?.phases ?? []) {
        for (const role of phase.roles ?? []) {
          if (role.kind !== 'actor' || role.siteId === null) continue
          const current = states.get(role.siteId)
          if (current === undefined || (rank[role.state] ?? 0) > (rank[current] ?? 0)) {
            states.set(role.siteId, role.state)
          }
        }
      }
      return states
    }

    /* ----------------------------------------------------------------- header */

    /** Amber outlined chip for the origin's 最大并发数 tag. */
    function ConcurrencyPill({ value }) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', borderRadius: 6, padding: '1px 7px',
          fontSize: 11.5, fontWeight: 500, lineHeight: '18px', whiteSpace: 'nowrap',
          border: '1px solid rgba(234,123,20,0.45)',
          color: T.amberText,
          background: 'rgba(234,123,20,0.06)',
        },
        'data-testid': 'concurrency-pill',
      }, zh['panel.maxConcurrency'](value))
    }

    function RunHeader({ trace, onCancel, onConfigure, onResume, onSelectRun, busy }) {
      const live = trace.status === 'running' || trace.status === 'pending'
      const resumable = trace.status === 'failed' || trace.status === 'cancelled'
      const actors = Array.isArray(trace.actors) ? trace.actors : []
      const roles = Array.isArray(trace.phases) ? trace.phases.flatMap((phase) => phase.roles ?? []) : []
      const working = roles.filter((role) => role.kind === 'actor' && role.state === 'running').length
      const tokens = formatTokens(trace.spentTokens)
      const parts = []
      if (actors.length === 0) {
        parts.push(zh['panel.noSubagents'])
      } else {
        parts.push(trace.resolvedModel !== null && trace.resolvedModel !== undefined
          ? `子代理 ${trace.resolvedModel}`
          : zh['panel.noSubagents'])
        parts.push(working > 0 ? zh['panel.subagentsWorking'](working) : zh['panel.subagents'](actors.length))
      }
      if (trace.totalSteps !== undefined) parts.push(zh['panel.steps'](trace.settledSteps ?? 0, trace.totalSteps))
      if (tokens !== null) parts.push(zh['panel.tokens'](tokens))
      if (trace.artifactCount !== undefined) parts.push(`${trace.artifactCount} 个产物`)
      parts.push(formatDuration(trace.durationMs))

      const configEvents = Array.isArray(trace.configEvents) ? trace.configEvents : []
      const lastConfig = configEvents[configEvents.length - 1]
      const statusColor = statusDot(trace.status)

      return h('div', { style: S.headerCard, 'data-run-status': trace.status }, [
        h('div', { key: 'top', style: S.headerTop }, [
          h('span', { key: 'title', style: S.title, title: trace.workflowId }, trace.workflowId),
          h('span', { key: 'actions', style: { display: 'flex', gap: 6, flex: 'none' } }, [
            h('button', {
              key: 'cfg', type: 'button', className: 'dsh-wf-btn', style: S.button,
              onClick: () => onConfigure?.(),
              'data-testid': 'run-configure',
            }, [h(IconSliders, { key: 'i', size: 12 }), h('span', { key: 'l' }, zh['panel.configure'])]),
            resumable
              ? h('button', {
                key: 'resume', type: 'button', className: 'dsh-wf-btn', style: S.button,
                onClick: () => onResume?.(),
                'data-testid': 'run-resume',
              }, [h(IconRotateCw, { key: 'i', size: 12 }), h('span', { key: 'l' }, zh['panel.resume'])])
              : null,
            live
              ? h('button', {
                key: 'stop', type: 'button', className: 'dsh-wf-btn', style: S.stopButton,
                onClick: () => onCancel?.(),
                disabled: busy === true,
                'data-testid': 'run-stop',
              }, [
                h(IconStopSquare, { key: 'i', size: 10 }),
                h('span', { key: 'l' }, busy === true ? zh['panel.stopping'] : zh['panel.stop']),
              ])
              : null,
          ].filter(Boolean)),
        ].filter(Boolean)),
        h('div', { key: 'meta', style: S.metaRow }, [
          h('span', {
            key: 'status',
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 500, color: statusColor },
          }, [
            h('span', { key: 'd', style: { ...S.dot, background: statusColor } }),
            h('span', { key: 'l' }, statusLabel(trace.status)),
          ]),
          Number(trace.maxConcurrency) > 0 ? h(ConcurrencyPill, { key: 'mc', value: trace.maxConcurrency }) : null,
          Number(trace.resumeCount) > 0
            ? h('span', { key: 'resume', style: S.pill }, zh['panel.resumed'](trace.resumeCount))
            : null,
        ].filter(Boolean)),
        trace.resumedFrom !== null && trace.resumedFrom !== undefined
          ? h('button', {
            key: 'src', type: 'button', className: 'dsh-wf-ghost',
            style: { ...S.ghostButton, padding: '1px 0', alignSelf: 'flex-start', fontSize: 11.5, color: T.labelTertiary },
            onClick: () => onSelectRun?.(trace.resumedFrom),
            'data-testid': 'run-lineage',
          }, zh['panel.source'](trace.resumedFrom))
          : (trace.lastResumedAt !== undefined
            ? h('div', { key: 'src2', style: S.meta }, zh['panel.resumedAt'](formatClock(trace.lastResumedAt)))
            : null),
        h('div', { key: 'summary', style: S.summary }, [
          h(IconSummaryList, { key: 'ic', size: 13 }),
          ...parts.flatMap((part, index) => (index === 0
            ? [h('span', { key: `p${index}`, style: { whiteSpace: 'nowrap' } }, part)]
            : [
              h('span', { key: `s${index}`, style: { opacity: 0.45 }, 'aria-hidden': 'true' }, '·'),
              h('span', { key: `p${index}`, style: { whiteSpace: 'nowrap' } }, part),
            ])),
        ]),
        lastConfig !== undefined
          ? h('div', {
            key: 'cfg', style: {
              display: 'flex', flexDirection: 'column', gap: 5,
              borderTop: `1px solid ${T.borderSoft}`, paddingTop: 10, marginTop: 4,
            },
          }, [
            h('div', { key: 'h', style: { fontSize: 11.5, color: T.labelTertiary } }, `${zh['panel.adjustedAt']} · ${formatClock(lastConfig.at)}`),
            h('div', {
              key: 'grid',
              style: { display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 3, columnGap: 10, fontSize: 12 },
            }, (Array.isArray(lastConfig.changes) ? lastConfig.changes : []).flatMap((change, index) => [
              h('span', { key: `cl${index}`, style: { color: T.labelTertiary } }, change.label),
              h('span', { key: `cv${index}`, style: { color: T.labelSecondary, fontVariantNumeric: 'tabular-nums' } }, `${change.from} → ${change.to}`),
            ])),
          ])
          : null,
        trace.error !== undefined && trace.status !== 'completed'
          ? h('div', { key: 'err', style: S.error }, trace.error)
          : null,
      ].filter(Boolean))
    }

    /* --------------------------------------------------------------- roster */

    /** Resolve one roster click; exported so the failure path is unit-testable. */
    async function openSubagentFromRoster(actor, onOpen) {
      if (actor?.sessionId === null || actor?.sessionId === undefined || actor?.sessionId === '') {
        return 'disabled'
      }
      const result = await onOpen?.(actor)
      return result === false ? 'failed' : result
    }

    /** All subagents of this run, merged from declarations and journal rows. */
    function SubAgentRoster({ trace, onOpen }) {
      const [open, setOpen] = useState(true)
      const [expanded, setExpanded] = useState(false)
      const [openError, setOpenError] = useState(undefined)
      const actors = Array.isArray(trace.actors) ? trace.actors : []
      const declared = Array.isArray(trace.declaredActors) ? trace.declaredActors : []
      const states = actorStatesOf(trace)
      const merged = actors.map((actor) => ({ ...actor, created: true, state: states.get(actor.siteId) ?? 'completed' }))
      for (const declaredActor of declared) {
        if (declaredActor.siteId === null) continue
        if (merged.some((actor) => actor.siteId === declaredActor.siteId)) continue
        merged.push({ ...declaredActor, created: false, state: states.get(declaredActor.siteId) ?? 'pending', tokens: 0, nodes: 0 })
      }
      if (merged.length === 0) return null
      const limit = 6
      const show = expanded || merged.length <= limit ? merged : merged.slice(0, limit)
      return h('div', { style: S.artifactSection, 'data-testid': 'subagent-roster' }, [
        h('button', {
          key: 'head', type: 'button', style: S.phaseButton,
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
          'data-testid': 'subagent-roster-toggle',
        }, [
          h('span', { key: 't', style: { ...S.sectionTitle, flex: 1 } }, `${zh['panel.subAgent']} ${merged.length}`),
          h(Chevron, { key: 'c', open }),
        ]),
        open ? h('div', { key: 'grid', style: S.actorGrid }, show.map((actor, index) => {
          const showActorModel = actor.model !== null && actor.model !== undefined && actor.model !== trace.resolvedModel
          const metaParts = [
            zh['panel.tasks'](actor.nodes ?? 0),
            Number(actor.durationMs) > 0 ? formatDuration(actor.durationMs) : null,
            formatTokens(actor.tokens) === null ? null : `${formatTokens(actor.tokens)}`,
            showActorModel ? String(actor.model) : null,
            actor.created === false ? '尚未创建' : null,
          ].filter(Boolean)
          const created = actor.sessionId !== null && actor.sessionId !== undefined && actor.sessionId !== ''
          return h('button', {
            key: `a${index}`, type: 'button',
            className: 'dsh-wf-pill',
            style: { ...S.actorRow, cursor: created ? 'pointer' : 'default', opacity: created ? 1 : 0.6 },
            onClick: created
              ? async () => {
                const outcome = await openSubagentFromRoster(actor, onOpen)
                if (outcome === 'failed') setOpenError(zh['panel.openSubagentFailed'])
              }
              : undefined,
            disabled: created !== true,
            title: created ? zh['panel.openSubagent'] : zh['panel.noSubagentSession'],
            'data-subagent-id': actor.sessionId ?? actor.siteId ?? `actor-${index}`,
            'data-subagent-disabled': created !== true,
          }, [
            h(Avatar, { key: 'av', name: actor.name ?? actor.siteId ?? '?', size: 24, state: actor.state }),
            h('span', { key: 'col', style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 1 } }, [
              h('span', { key: 'n', style: { ...S.roleName, fontSize: 12 } }, actor.name ?? actor.siteId ?? zh['panel.anonymous']),
              h('span', {
                key: 'meta',
                style: { ...S.roleMeta, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, metaParts.join(' · ')),
            ]),
            actor.state === 'running'
              ? h(IconSpinner, { key: 'spin', size: 12, color: T.warning })
              : actor.state === 'failed'
                ? h(IconCrossSmall, { key: 'fail', size: 11 })
                : (created ? h(IconArrowUpRight, { key: 'go', size: 11 }) : null),
          ].filter(Boolean))
        })) : null,
        open && openError !== undefined
          ? h('div', { key: 'open-error', style: S.error, role: 'alert', 'data-testid': 'subagent-open-error' }, openError)
          : null,
        open && merged.length > limit
          ? h('button', {
            key: 'more', type: 'button', className: 'dsh-wf-ghost',
            style: { ...S.ghostButton, alignSelf: 'flex-start' },
            onClick: () => setExpanded((value) => !value),
          }, expanded ? zh['panel.collapseAll'] : zh['panel.expandAll'](merged.length))
          : null,
      ].filter(Boolean))
    }

    /* --------------------------------------------------------------- config */

    function ConfigDialog({ trace, sessionId, ctx, onClose, onApply, busy }) {
      const [maxConcurrency, setMaxConcurrency] = useState(Number(trace.maxConcurrency) || 13)
      const [, setCatalogVersion] = useState(0)
      // The directory is lazy: ask it to load, then re-read its snapshot. A
      // composition without the service simply keeps the session option.
      useEffect(() => {
        let cancelled = false
        try {
          const directory = ctx?.get?.('modelDirectories')?.directoryFor?.(sessionId)
          const loading = directory?.load?.()
          if (loading?.then !== undefined) {
            loading.then(() => {
              if (cancelled !== true) setCatalogVersion((value) => value + 1)
            }, () => {})
          }
        } catch {
          // ignore: the fallback note explains the limited choice
        }
        return () => { cancelled = true }
      }, [ctx, sessionId])
      const [model, setModel] = useState(
        trace.subagentModel === null || trace.subagentModel === undefined || trace.subagentModel === '会话模型'
          ? 'session'
          : trace.subagentModel,
      )
      const options = readModelOptions(ctx, sessionId)
      // A pinned model must stay visible before (or without) the directory:
      // otherwise the select has no matching option and React shows the first
      // one, falsely reading as "follow the session model".
      if (model !== 'session' && !options.some((option) => option.value === model)) {
        options.unshift({ value: model, label: model })
      }
      const onlySession = options.length === 1
      return h('div', { style: S.dialogBackdrop, role: 'dialog', 'aria-modal': 'true', 'data-testid': 'config-dialog' }, [
        h('div', { key: 'card', style: S.dialogCard }, [
          h('div', { key: 't', style: { ...S.title, flex: 'none' } }, zh['panel.configTitle']),
          h('div', { key: 'row1', style: S.dialogRow }, [
            h('span', { key: 'l', style: { fontSize: 12.5, color: T.labelSecondary } }, zh['panel.maxConcurrencyLabel']),
            h('span', { key: 'ctrl', style: S.stepper }, [
              h('button', {
                key: 'minus', type: 'button', className: 'dsh-wf-btn', style: S.stepperButton,
                onClick: () => setMaxConcurrency((value) => Math.max(1, Number(value) - 1)),
                'aria-label': 'decrease', 'data-testid': 'concurrency-minus',
              }, '−'),
              h('span', { key: 'v', style: S.stepperValue, 'data-testid': 'concurrency-value' }, String(maxConcurrency)),
              h('button', {
                key: 'plus', type: 'button', className: 'dsh-wf-btn', style: S.stepperButton,
                onClick: () => setMaxConcurrency((value) => Math.min(64, Number(value) + 1)),
                'aria-label': 'increase', 'data-testid': 'concurrency-plus',
              }, '+'),
            ]),
          ]),
          h('div', { key: 'row2', style: S.dialogRow }, [
            h('span', { key: 'l', style: { fontSize: 12.5, color: T.labelSecondary } }, zh['panel.model']),
            h('select', {
              key: 's', style: S.select, value: model,
              onChange: (event) => setModel(event.currentTarget.value),
              'data-testid': 'model-select',
            }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
          ]),
          onlySession ? h('div', { key: 'note', style: S.meta }, zh['panel.modelUnavailable']) : null,
          h('div', { key: 'actions', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 } }, [
            h('button', { key: 'cancel', type: 'button', className: 'dsh-wf-btn', style: S.button, onClick: onClose }, zh['panel.cancel']),
            h('button', {
              key: 'apply', type: 'button',
              style: { ...S.button, background: T.accent, borderColor: T.accent, color: '#ffffff' },
              disabled: busy === true,
              onClick: () => onApply?.({ maxConcurrency, subagentModel: model }),
              'data-testid': 'config-apply',
            }, busy === true ? zh['panel.loading'] : zh['panel.apply']),
          ]),
        ]),
      ])
    }

    /** 当前会话 / 当前目录 / 全部 — default is the narrowest scope. */
    function ScopeChips({ scope, onChange, cwdAvailable, sessionAvailable = true }) {
      const items = [
        ...(sessionAvailable ? [{ id: 'session', label: zh['panel.scope.session'] }] : []),
        ...(cwdAvailable ? [{ id: 'cwd', label: zh['panel.scope.cwd'] }] : []),
        { id: 'all', label: zh['panel.scope.all'] },
      ]
      return h('div', {
        style: { display: 'inline-flex', gap: 2, background: T.moduleBg, borderRadius: 999, padding: 2 },
        'data-testid': 'scope-chips',
      },
        items.map((item) => h('button', {
          key: item.id,
          type: 'button',
          style: {
            border: 'none', borderRadius: 999, padding: '2px 10px', fontSize: 11,
            fontWeight: scope === item.id ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit',
            background: scope === item.id ? T.panelBg : 'transparent',
            color: scope === item.id ? T.labelPrimary : T.labelTertiary,
            boxShadow: scope === item.id ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            transition: 'background .12s ease, color .12s ease',
          },
          onClick: () => onChange(item.id),
          'data-scope': item.id,
          'aria-pressed': scope === item.id,
        }, item.label)))
    }

    /* -------------------------------------------------------------- timeline */

    const PHASE_STATUS_COLOR = {
      completed: T.success,
      running: T.warning,
      failed: T.error,
      pending: T.labelTertiary,
    }

    function defaultPhaseOpen(phase, onlyPhase) {
      if (phase.status === 'running' || phase.status === 'failed') return true
      if (onlyPhase === true && phase.status === 'completed') return true
      return false
    }

    function RolePill({ phase, role, open, onToggle, traceNodes, resolvedModel }) {
      const showModel = role.kind !== 'world' && role.model !== null && role.model !== undefined && role.model !== resolvedModel
      return h('div', { style: S.roleRow }, [
        h('button', {
          key: 'pill',
          type: 'button',
          className: 'dsh-wf-pill',
          style: S.rolePill,
          onClick: () => onToggle(role.key),
          'aria-expanded': open === true,
          'aria-controls': `role-nodes-${phase.id}-${role.key}`,
          'data-role-key': role.key,
          'data-role-kind': role.kind,
          'data-role-toggle': `role-nodes-${phase.id}-${role.key}`,
        }, [
          role.kind === 'world'
            ? h(WorldBadge, { key: 'w', size: 20 })
            : h(Avatar, { key: 'a', name: role.name ?? role.siteId, size: 20, state: role.state }),
          h('span', { key: 'n', style: S.roleName }, role.kind === 'world' ? zh['panel.worldGroup'] : (role.name ?? role.siteId ?? zh['panel.noSubagents'])),
          showModel
            ? h('span', { key: 'model', style: { ...S.meta, fontSize: 10.5 } }, String(role.model))
            : null,
          h('span', { key: 'm', style: S.roleMeta }, role.kind === 'world' ? zh['panel.ops'](role.total) : zh['panel.tasks'](role.total)),
          role.state === 'running'
            ? h('span', { key: 's', style: S.roleState }, h(IconSpinner, { size: 13, color: T.warning }))
            : role.state === 'failed'
              ? h('span', { key: 's', style: S.roleState }, h(IconCrossSmall, { size: 12 }))
              : null,
          h(Chevron, { key: 'c', open: open === true, size: 9 }),
        ].filter(Boolean)),
        open === true
          ? h('div', { key: 'nodes', id: `role-nodes-${phase.id}-${role.key}`, style: S.nodeList },
            // Fallback for an older projection that kept nodes only at the top
            // level: an empty drill-down is worse than a slightly slower lookup.
            (Array.isArray(phase.nodes) && phase.nodes.length > 0 ? phase.nodes : (traceNodes ?? []))
              .filter((node) => node.roleKey === role.key)
              .map((node) => h(NodeCard, { key: `${node.siteId}#${node.ordinal}`, node, defaultOpen: true })))
          : null,
      ].filter(Boolean))
    }

    function PhaseRow({ phase, index = 0, total = 1, prevStatus, open, onToggle, openRoles, onToggleRole, onlyPhase, traceNodes, resolvedModel }) {
      const [hover, setHover] = useState(false)
      const color = PHASE_STATUS_COLOR[phase.status] ?? T.labelTertiary
      const prevColor = PHASE_STATUS_COLOR[prevStatus] ?? T.borderSoft
      const isLastPending = phase.status === 'pending' && index === total - 1 && total > 1
      const lamp = isLastPending
        ? {
          position: 'absolute', left: 2.5, top: 11.5, width: 13, height: 13, borderRadius: '50%',
          background: T.panelBg, border: `1.5px solid ${T.borderSoft}`, boxSizing: 'border-box', zIndex: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }
        : phase.status === 'pending'
          ? { ...S.lamp, background: T.panelBg, border: `1.5px solid ${T.border}` }
          : phase.status === 'running'
            ? { ...S.lamp, background: color, boxShadow: '0 0 0 4px rgba(234,123,20,0.20)' }
            : {
              ...S.lamp,
              background: color,
              boxShadow: phase.status === 'failed'
                ? '0 0 0 2px rgba(220,38,38,0.12)'
                : '0 0 0 2px rgba(22,163,74,0.12)',
            }
      const fraction = phase.observedCount > 0 ? `${phase.settledCount}/${phase.observedCount}` : ''
      return h('div', {
        className: 'dsh-wf-phase',
        style: { ...S.phaseRow, background: hover ? T.activeBg : 'transparent' },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        'data-phase-id': phase.id,
        'data-phase-status': phase.status,
      }, [
        // Exact dot-to-dot vertical connectors (never sticking past endpoints
        // or slicing across hollow pending circles).
        h('span', {
          key: 'segment',
          style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 18, pointerEvents: 'none' },
          'data-rail-segment': phase.status,
        }, [
          index > 0
            ? h('span', {
              key: 'top',
              style: {
                position: 'absolute', left: 8, top: 0, height: 13, width: 2, borderRadius: 1,
                background: prevStatus === 'pending' ? T.borderSoft : prevColor,
                opacity: prevStatus === 'pending' ? 1 : 0.42,
              },
            })
            : null,
          index < total - 1
            ? h('span', {
              key: 'bot',
              style: {
                position: 'absolute', left: 8, top: 23, bottom: 0, width: 2, borderRadius: 1,
                background: phase.status === 'pending' ? T.borderSoft : color,
                opacity: phase.status === 'pending' ? 1 : 0.42,
              },
            })
            : null,
        ].filter(Boolean)),
        h('span', {
          key: 'lamp',
          className: phase.status === 'running' ? 'dsh-wf-pulse' : undefined,
          style: lamp,
          'data-lamp': phase.status,
        }, isLastPending
          ? h('span', { style: { width: 5, height: 5, borderRadius: '50%', background: T.labelTertiary, opacity: 0.65 } })
          : null),
        h('button', {
          key: 'head',
          type: 'button',
          style: S.phaseButton,
          onClick: () => onToggle(phase.id),
          'aria-expanded': open === true,
          'aria-label': `${open === true ? zh['panel.collapse'] : zh['panel.expand']}阶段 ${phase.title}`,
          'data-testid': 'phase-toggle',
          'data-phase-status': phase.status,
        }, [
          h('span', { key: 'title', style: S.phaseTitleWrap },
            h('span', {
              key: 't',
              style: {
                ...S.phaseTitle,
                fontWeight: phase.status === 'running' || phase.status === 'failed' ? 600 : (phase.status === 'pending' ? 450 : 500),
                color: phase.status === 'pending' ? T.labelSecondary : T.labelPrimary,
              },
            }, phase.title)),
          h('span', { key: 'right', style: S.phaseRight }, [
            h(AvatarCluster, { key: 'cluster', roles: phase.roles ?? [] }),
            fraction !== '' ? h('span', { key: 'f', style: S.fraction }, fraction) : null,
            h(Chevron, { key: 'c', open: open === true }),
          ].filter(Boolean)),
        ].filter(Boolean)),
        open === true && (phase.roles ?? []).length > 0
          ? h('div', { key: 'roles', style: S.roleList },
            (phase.roles ?? []).map((role) => h(RolePill, {
              key: role.key,
              phase,
              role,
              open: openRoles[`${phase.id}:${role.key}`] === true,
              onToggle: (key) => onToggleRole(`${phase.id}:${key}`),
              traceNodes,
              resolvedModel,
            })))
          : null,
      ].filter(Boolean))
    }

    function PhaseTimeline({ phases, traceNodes, resolvedModel }) {
      const list = Array.isArray(phases) ? phases : []
      const [openPhases, setOpenPhases] = useState({})
      const [openRoles, setOpenRoles] = useState({})
      if (list.length === 0) return null
      const onlyPhase = list.length === 1
      const togglePhase = (id) => setOpenPhases((current) => ({ ...current, [id]: !(current[id] ?? defaultPhaseOpen(list.find((p) => p.id === id), onlyPhase)) }))
      const toggleRole = (key) => setOpenRoles((current) => ({ ...current, [key]: !(current[key] === true) }))
      return h('div', { style: S.timeline, 'data-testid': 'phase-timeline' },
        list.map((phase, index) => h(PhaseRow, {
          key: phase.id,
          phase,
          index,
          total: list.length,
          prevStatus: index > 0 ? list[index - 1]?.status : undefined,
          onlyPhase,
          open: openPhases[phase.id] ?? defaultPhaseOpen(phase, onlyPhase),
          onToggle: togglePhase,
          openRoles,
          onToggleRole: toggleRole,
          traceNodes,
          resolvedModel,
        })))
    }

    /* ---------------------------------------------------------------- page */

    function ArtifactSection({ artifacts }) {
      const [open, setOpen] = useState(true)
      const [openId, setOpenId] = useState(undefined)
      const list = Array.isArray(artifacts) ? artifacts : []
      const selected = list.find((artifact) => artifact.id === openId)
      if (list.length === 0) {
        return h('div', { style: { ...S.meta, paddingTop: 10, borderTop: `1px solid ${T.borderSoft}` } }, zh['panel.noArtifacts'])
      }
      return h('div', { style: S.artifactSection, 'data-testid': 'artifact-section' }, [
        h('button', {
          key: 'head',
          type: 'button',
          style: { ...S.phaseButton, gap: 6 },
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
          'data-testid': 'artifact-section-toggle',
        }, [
          h('span', { key: 't', style: { ...S.sectionTitle, flex: 1 } }, `${zh['panel.artifacts']} ${list.length}`),
          h(Chevron, { key: 'c', open }),
        ]),
        open
          ? h('div', { key: 'grid', style: S.artifactGrid },
            list.map((artifact) => h(ArtifactTile, {
              key: artifact.id,
              artifact,
              active: artifact.id === openId,
              onOpen: (id) => setOpenId((current) => (current === id ? undefined : id)),
            })))
          : null,
        open && selected !== undefined
          ? h(ArtifactCard, { key: 'detail', artifact: selected, reports: selected.reports })
          : null,
      ].filter(Boolean))
    }

    function RunDetail({ trace, ctx, onCancel, onConfigure, onResume, onSelectRun, busy }) {
      const runKey = trace.runId ?? 'run'
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [
        h(RunHeader, {
          key: `header:${runKey}`, trace, onCancel, onConfigure, onResume, onSelectRun, busy,
        }),
        h(PhaseTimeline, {
          key: `timeline:${runKey}`, phases: trace.phases, traceNodes: trace.nodes, resolvedModel: trace.resolvedModel,
        }),
        h(ArtifactSection, { key: `artifacts:${runKey}`, artifacts: trace.artifacts }),
        h(SubAgentRoster, {
          key: `roster:${runKey}`, trace,
          onOpen: (actor) => openSubagentSession({
            sessions: ctx?.get?.('sessions'),
            layout: ctx?.get?.('layout'),
            workspace: ctx?.get?.('uiWorkspace'),
          }, trace.parentSessionId, actor.sessionId),
        }),
      ].filter(Boolean))
    }

    function WorkflowPage({ compact = false, sessionId: sessionIdProp, ctx }) {
      const sessionId = typeof sessionIdProp === 'string' && sessionIdProp !== ''
        ? sessionIdProp
        : currentSessionIdFrom(ctx)
      const cwd = resolveSessionCwd(ctx, sessionId)
      // Narrowest scope by default: a session panel must never show another
      // session's history just because it happens to share the machine.
      const [scope, setScope] = useState(defaultScopeFor(sessionId))
      const [runs, setRuns] = useState([])
      const [selected, setSelected] = useState(undefined)
      const [trace, setTrace] = useState(undefined)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [configOpen, setConfigOpen] = useState(false)

      const loadRuns = useCallback(async (silent = false) => {
        if (silent !== true) setLoading(true)
        try {
          const value = await callRoute('runs', runsQueryFor(scope, sessionId, cwd))
          const list = value?.runs ?? []
          setRuns(list)
          setError(undefined)
          setSelected((current) => {
            if (current !== undefined && list.some((run) => run.runId === current)) return current
            return list[0]?.runId
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (silent !== true) setLoading(false)
        }
      }, [scope, sessionId, cwd])

      const loadTrace = useCallback(async (runId, silent = false) => {
        if (runId === undefined) return
        try {
          const value = await callRoute('run', {
            runId,
            // Only the session scope is identity-restricted; browsing a cwd or
            // the whole journal intentionally reads other sessions' runs.
            ...(scope === 'session' && sessionId !== undefined ? { sessionId } : {}),
          })
          setTrace(value)
          if (silent !== true) setError(undefined)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [scope, sessionId])

      // Switching session (or scope) must drop the previous run immediately:
      // otherwise the new session briefly shows another session's trace.
      useEffect(() => {
        setSelected(undefined)
        setTrace(undefined)
      }, [sessionId, scope])

      useEffect(() => {
        loadRuns()
      }, [loadRuns])

      useEffect(() => {
        if (selected === undefined) {
          setTrace(undefined)
          return undefined
        }
        loadTrace(selected)
        return undefined
      }, [selected, loadTrace])

      // Live polling: while anything is running, refresh quietly every 1.2s.
      // It stops by itself when every run has settled.
      const live = (trace !== undefined && (trace.status === 'running' || trace.status === 'pending'))
        || runs.some((run) => run.status === 'running' || run.status === 'pending')
      useEffect(() => {
        if (live !== true) return undefined
        const timer = setInterval(() => {
          loadRuns(true)
          if (selected !== undefined) loadTrace(selected, true)
        }, 1200)
        return () => clearInterval(timer)
      }, [live, selected, loadRuns, loadTrace])

      const refresh = useCallback(() => {
        loadRuns(true)
        if (selected !== undefined) loadTrace(selected, true)
      }, [loadRuns, loadTrace, selected])

      const stop = useCallback(async () => {
        if (selected === undefined) return
        setBusy(true)
        try {
          await callRoute('cancel', { runId: selected })
          await loadRuns(true)
          await loadTrace(selected, true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [selected, loadRuns, loadTrace])

      const resume = useCallback(async () => {
        if (trace === undefined) return
        setBusy(true)
        try {
          await callRoute('resume', { runId: trace.runId })
          await loadRuns(true)
          await loadTrace(trace.runId, true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [trace, loadRuns, loadTrace])

      const applyConfig = useCallback(async ({ maxConcurrency, subagentModel }) => {
        if (trace === undefined) return
        setBusy(true)
        try {
          const result = await callRoute('configure', {
            runId: trace.runId, maxConcurrency, subagentModel,
          })
          setConfigOpen(false)
          await loadRuns(true)
          if (typeof result?.runId === 'string') setSelected(result.runId)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [trace, loadRuns])

      const removeRun = useCallback(async (runId) => {
        if (!runId) return
        setBusy(true)
        try {
          await callRoute('delete', { runId })
          await loadRuns(true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [loadRuns])

      useEffect(() => {
        ensureStyles()
      }, [])

      const header = h('div', {
        key: 'header', style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' },
      }, [
        h(ScopeChips, {
          key: 'scope', scope, onChange: setScope,
          cwdAvailable: cwd !== undefined,
          sessionAvailable: sessionId !== undefined,
        }),
        h('span', { key: 'sp', style: { flex: 1 } }),
        h('button', {
          key: 'refresh', type: 'button', className: 'dsh-wf-ghost',
          style: { ...S.ghostButton, padding: '4px 6px' },
          onClick: () => refresh(),
          disabled: loading,
          title: zh['panel.refresh'],
          'aria-label': zh['panel.refresh'],
          'data-testid': 'panel-refresh',
        }, h(IconRotateCw, { size: 13 })),
      ].filter(Boolean))

      // A one-frame guard against the reset effect: never render a trace whose
      // session does not match the session scope currently on screen.
      const traceMatchesScope = trace === undefined
        || scope !== 'session'
        || sessionId === undefined
        || trace.parentSessionId === sessionId
        || trace.parentSessionId === null
        || trace.parentSessionId === undefined

      const body = []
      if (error !== undefined) body.push(h('div', { key: 'err', style: S.error }, error))
      if (loading && runs.length === 0) {
        body.push(h('div', { key: 'loading', style: S.meta }, zh['panel.loading']))
      } else if (runs.length === 0) {
        body.push(h('div', { key: 'empty', style: { ...S.meta, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 12 } }, [
          h('div', { key: 'a', style: { color: T.labelSecondary, fontSize: 12.5 } }, scope === 'session' ? zh['panel.emptySession'] : zh['panel.noRunsInScope']),
          scope === 'session' ? null : h('div', { key: 'b', style: { color: T.labelTertiary, fontSize: 11.5 } }, zh['panel.emptyHint']),
        ].filter(Boolean)))
      } else {
        if (runs.length > 1) {
          body.push(h(RunSwitcher, {
            key: 'switcher', runs, selectedId: selected, onSelect: setSelected, onDelete: removeRun,
          }))
        }
        if (trace !== undefined && traceMatchesScope) {
          body.push(h('div', { key: `detail:${trace.runId}`, style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [
            h(RunDetail, {
              key: `detail-inner:${trace.runId}`,
              trace, ctx,
              onCancel: stop, onResume: resume, busy,
              onConfigure: () => setConfigOpen(true),
              onSelectRun: (runId) => setSelected(runId),
            }),
          ]))
        }
      }

      return h('div', { style: S.root, className: 'dsh-wf-root', 'data-compact': compact ? 'true' : 'false', 'data-scope-active': scope }, [
        header,
        ...body,
        configOpen && trace !== undefined
          ? h(ConfigDialog, {
            key: `config:${trace.runId}`,
            trace, sessionId, ctx, busy,
            onClose: () => setConfigOpen(false),
            onApply: applyConfig,
          })
          : null,
      ].filter(Boolean))
    }

    /* --------------------------------------------------------- sidebar entry */

    function WorkflowFooterButton({ wide, selectPanel }) {
      // Deliberately no `usePanelInfo()`: that hook is bound to the panel seats,
      // and calling it from a footer action throws and unmounts the button.
      const label = zh['entry.label']
      return h('button', {
        type: 'button',
        style: {
          ...S.footerButton,
          ...(wide ? S.footerButtonWide : S.footerButtonRail),
        },
        title: label,
        'aria-label': label,
        onClick: () => {
          if (typeof selectPanel === 'function') selectPanel(PANEL_ID)
        },
      }, [
        h(WorkflowIcon, { key: 'g', size: wide ? 16 : 18 }),
        wide ? h('span', { key: 'l', style: S.footerLabel }, label) : null,
      ].filter(Boolean))
    }

    function WorkflowIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        'data-dsh-panel-entry': PANEL_ID,
      }, [
        h('rect', { key: 'box', x: 1.75, y: 2.25, width: 12.5, height: 11.5, rx: 1.75 }),
        h('path', { key: 'l1', d: 'M4.5 5.75h3.5' }),
        h('path', { key: 'l2', d: 'M4.5 8.25h2.5' }),
        h('path', { key: 'l3', d: 'M8.25 5.75v5.5h3.25' }),
      ])
    }

    function WorkflowGlyph(props) {
      return h(WorkflowIcon, props)
    }

    function WorkflowRightTab(props) {
      return h(WorkflowPage, {
        compact: true,
        sessionId: props?.sessionId,
        ctx: props?.ctx,
      })
    }

    return {
      // Pure helpers and components, exported so the offline tests can pin the
      // labels, the formatting and the element tree without a browser.
      __internals: {
        statusLabel, statusDot, formatDuration, formatClock, formatTokens, nodeTitle, isWorldNode,
        hashString, avatarPalette, defaultPhaseOpen, EMPTY_ARTIFACT,
        NodeCard, ArtifactCard, ArtifactTile, ArtifactPreview, ArtifactSection,
        RunCard, RunSwitcher, RunDetail, RunHeader, PhaseRow, PhaseTimeline, Avatar, AvatarCluster, RolePill,
        ScopeChips, SubAgentRoster, ConfigDialog, ConcurrencyPill, WorkflowPage, WorkflowRightTab,
        openSubagentSession, resolveSessionCwd, readModelOptions, actorStatesOf, defaultScopeFor, currentSessionIdFrom, runsQueryFor,
        openSubagentFromRoster,
      },

      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        const disposers = []
        disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PANEL_ID,
          order: 50,
          label: () => zh['entry.label'],
          inject: () => ({
            selectPanel: () => {
              // Opening a tab can fail when there is no active conversation
              // (or the sidebar is mid-teardown). Falling back to the layout
              // service keeps the button useful instead of throwing into React.
              try {
                const right = ctx.get?.('sidebarRight')
                if (right?.openTab !== undefined) {
                  right.openTab(PANEL_ID)
                  return true
                }
              } catch {
                // try the layout fallback below
              }
              try {
                const layout = ctx.get?.('layout')
                if (typeof layout?.selectPanel === 'function') {
                  layout.selectPanel(PANEL_ID)
                  return true
                }
              } catch {
                // no layout service either
              }
              return false
            },
          }),
        }, WorkflowFooterButton)))
        // The page needs the plugin context for model directories and subagent
        // navigation; the Host owns the slot props, so inject ours in a wrapper.
        const PageWithContext = (props) => h(WorkflowPage, { ...(props ?? {}), ctx })
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PageWithContext)))

        // The guide card in the right column's "Start" page. The `guide` array
        // describes ONLY this type's own card; the shipped guide keeps its own
        // registration, so this is not a takeover.
        //
        // `sidebarRightTabs` is provided by the sidebar-right plugin only after
        // its own eight services are ready. On a cold start that can happen
        // AFTER this plugin's apply(), so a one-shot `ctx.get` here used to skip
        // the tab type forever — and a persisted `{kind:'zcode-workflow'}` tab
        // then rendered as "这类内容还没有可用的查看方式". Deferred injection
        // makes the registration happen whenever the service actually appears.
        const registerRightTab = (rightCtx) => {
          const tabs = rightCtx?.get?.('sidebarRightTabs') ?? ctx.get?.('sidebarRightTabs')
          if (tabs?.register === undefined) return undefined
          const slots = rightCtx?.slots ?? ctx.slots
          const local = []
          local.push(rightCtx?.effect?.(() => tabs.register({
            id: PANEL_ID,
            kind: PANEL_ID,
            priority: 'extension',
            title: () => zh['entry.label'],
            guide: [{
              // `guide-pins` keys entries by `${kind}:${id}`; without an id the
              // card cannot be pinned and the Start page entry is incomplete.
              id: PANEL_ID,
              order: 60,
              title: () => zh['entry.label'],
              description: () => zh['guide.description'],
              icon: WorkflowGlyph,
            }],
          }), 'dsh-workflow-zcode: right tab type'))
          // The Host renders this seat with `{ sessionId, useTabInfo, ... }`
          // only — it does NOT hand over the plugin context. Without this
          // wrapper the page loses modelDirectories, the cwd filter and
          // subagent navigation in the real right column.
          const RightTabWithContext = (props) => h(WorkflowRightTab, {
            ...(props ?? {}),
            ctx: props?.ctx ?? ctx,
          })
          local.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
            name: 'sidebar.right.pane.tab',
            key: PANEL_ID,
          }, RightTabWithContext)))
          return () => {
            for (const dispose of local.reverse()) {
              try {
                dispose?.()
              } catch {
                // the shell tearing down is not an error
              }
            }
          }
        }

        if (typeof ctx.inject === 'function') {
          const handle = ctx.inject(['sidebarRightTabs'], (rightCtx) => registerRightTab(rightCtx))
          disposers.push(typeof handle === 'function' ? handle : () => handle?.dispose?.())
        } else {
          // A lightweight host without deferred injection (unit-test mocks,
          // minimal compositions): try once, synchronously.
          const dispose = registerRightTab(ctx)
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        return () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch {
              // the shell tearing down is not an error
            }
          }
        }
      },
    }
  },
})