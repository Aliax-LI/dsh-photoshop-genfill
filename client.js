/**
 * Client half of @local/dsh-photoshop-genfill.
 *
 * Registers one ambient entry in the session-scoped `conversation.composer.dock`
 * slot: a compact single row (Photoshop status dot, generation mode, prompt,
 * submit) plus status/undo icon buttons and a one-line result area. Submitting
 * executes the plugin's global slash commands through the Client Remote, so the
 * Host runs the Photoshop + image-API pipeline:
 *
 *   ctx.get('remote.commands').execute(sessionId, '/<command> <prompt>', [])
 *   -> { ok: true, value: { commandId, result: { kind: 'success' | 'error', text? } } }
 *   -> { ok: false, error: { code, message } }
 *
 * Framework facts verified against the installed packages:
 * - `window.__ModuleLoader__.load({ id, factory })` is the static Client module form
 *   (dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js).
 * - slot registrations that declare `locale: NS` receive the framework `t` seat as a
 *   prop and re-render on locale revision changes
 *   (dsh-client-ui-renderer/lib/client.js localeSeat/useLocaleRevision; live example
 *   dsh-client-ui-goal/lib/client.js).
 * - `ctx.locale.register(ns, { zh, en })` returns a disposer; `ctx.locale.bind(ns)`
 *   returns the stable translator (dsh-client-locale/README.md + lib/client.js).
 * - The dock slot is a session-scoped list with `id`/`order` register options and
 *   `sessionId` among the standard props (client-ui-conversation slot catalog as
 *   exposed by the cordis client runner slot reference).
 *
 * Only `react` is required; all styling is a component-local <style> element and
 * uses color through --dsw-alias-* theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-photoshop-genfill',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'ps-genfill'

    /** Simplified Chinese dictionary (key-set source of truth; the primary locale). */
    const zh = {
      'panel.label': 'PS 生成式填充',
      'panel.aria': 'Photoshop 生成式填充面板',
      'mode.aria': '生成模式',
      'mode.fill': '填充',
      'mode.gen': '生成',
      'mode.edit': '编辑',
      'prompt.aria': '提示词',
      'prompt.placeholder.fill': '描述要填充的内容…',
      'prompt.placeholder.gen': '描述要生成的图层…',
      'prompt.placeholder.edit': '描述要修改的内容…',
      'action.run.fill': '填充',
      'action.run.gen': '生成',
      'action.run.edit': '编辑',
      'action.busy': '处理中',
      'action.status': '查询 Photoshop 状态',
      'action.undo': '撤销上一步',
      'action.dismiss': '关闭提示',
      'status.label.ready': 'Photoshop 就绪',
      'status.label.busy': 'Photoshop 处理中',
      'status.label.error': 'Photoshop 异常',
      'status.label.idle': 'Photoshop 状态未知',
      'status.busy': '处理中…',
      'status.elapsed': '已用 {seconds} 秒',
      'result.ok': '完成',
      'error.unknown': '命令执行失败，未返回结果',
      'error.unavailable': '远程命令服务不可用，请重启 Harness',
    }

    /** English dictionary, the same key set as `zh`. */
    const en = {
      'panel.label': 'PS Generative Fill',
      'panel.aria': 'Photoshop generative fill panel',
      'mode.aria': 'Generation mode',
      'mode.fill': 'Fill',
      'mode.gen': 'Generate',
      'mode.edit': 'Edit',
      'prompt.aria': 'Prompt',
      'prompt.placeholder.fill': 'Describe what to fill…',
      'prompt.placeholder.gen': 'Describe the layer to generate…',
      'prompt.placeholder.edit': 'Describe the edit…',
      'action.run.fill': 'Fill',
      'action.run.gen': 'Generate',
      'action.run.edit': 'Edit',
      'action.busy': 'Working',
      'action.status': 'Check Photoshop status',
      'action.undo': 'Undo last step',
      'action.dismiss': 'Dismiss message',
      'status.label.ready': 'Photoshop ready',
      'status.label.busy': 'Photoshop working',
      'status.label.error': 'Photoshop error',
      'status.label.idle': 'Photoshop status unknown',
      'status.busy': 'Working…',
      'status.elapsed': '{seconds}s elapsed',
      'result.ok': 'Done',
      'error.unknown': 'Command failed without a result',
      'error.unavailable': 'Command service unavailable; restart Harness',
    }

    /** Mode id, slash command and locale key suffix. */
    const MODES = [
      { id: 'fill', command: 'psfill' },
      { id: 'gen', command: 'psgen' },
      { id: 'edit', command: 'psedit' },
    ]

    /** All styling. Colors come from --dsw-alias-* theme tokens (light + dark safe). */
    const STYLE = [
      '.psg-root{display:flex;flex-direction:column;gap:4px;flex:1 1 420px;min-width:0;max-width:100%}',
      '.psg-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;min-width:0;padding:0 6px 0 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease}',
      '.psg-row:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
      '.psg-row[data-busy=true]{opacity:.9}',
      '.psg-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption);transition:background-color .15s ease}',
      '.psg-dot[data-state=ready]{background:var(--dsw-alias-state-success-primary)}',
      '.psg-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}',
      '.psg-dot[data-state=busy]{background:var(--dsw-alias-state-business-primary);animation:psg-pulse 1s ease-in-out infinite}',
      '.psg-label{flex:none;font-size:12px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.psg-divider{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l2)}',
      '.psg-mode{position:relative;display:inline-flex;flex:none;align-items:center}',
      '.psg-select{appearance:none;-webkit-appearance:none;-moz-appearance:none;box-sizing:border-box;height:24px;padding:0 16px 0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;font-weight:500;line-height:16px;cursor:pointer}',
      '.psg-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.psg-select:disabled{opacity:.5;cursor:default}',
      '.psg-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.psg-mode:after{content:"";position:absolute;right:6px;top:50%;width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-top:4px solid var(--dsw-alias-label-tertiary);transform:translateY(-50%);pointer-events:none}',
      '.psg-input{flex:1 1 80px;min-width:48px;height:26px;padding:0 2px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}',
      '.psg-input::placeholder{color:var(--dsw-alias-label-caption)}',
      '.psg-input:disabled{color:var(--dsw-alias-label-tertiary)}',
      '.psg-primary{display:inline-flex;flex:none;align-items:center;gap:5px;box-sizing:border-box;height:24px;padding:0 10px;border:0;border-radius:7px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-inverted);font-family:inherit;font-size:12px;font-weight:600;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,opacity .12s ease}',
      '.psg-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}',
      '.psg-primary:disabled{opacity:.45;cursor:default}',
      '.psg-iconBtn{display:grid;place-items:center;flex:none;box-sizing:border-box;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.psg-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.psg-iconBtn:disabled{opacity:.4;cursor:default}',
      '.psg-primary:focus-visible,.psg-iconBtn:focus-visible,.psg-select:focus-visible,.psg-dismiss:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.psg-result{display:flex;align-items:center;gap:6px;min-width:0;padding:0 8px 0 10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}',
      '.psg-result[data-kind=error]{color:var(--dsw-alias-state-error-primary)}',
      '.psg-resultText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.psg-dismiss{display:grid;place-items:center;flex:none;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;cursor:pointer}',
      '.psg-elapsed{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.psg-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.psg-spinner{flex:none;box-sizing:border-box;width:11px;height:11px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:psg-spin .7s linear infinite}',
      '@keyframes psg-spin{to{transform:rotate(360deg)}}',
      '@keyframes psg-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@media (prefers-reduced-motion:reduce){.psg-dot[data-state=busy]{animation:none}.psg-spinner{animation:none}}',
      '@media (max-width:720px){.psg-label,.psg-divider{display:none}}',
    ].join('')

    /** 16x16 activity glyph for the "check Photoshop status" button. */
    function StatusIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', {
          d: 'M2.2 8.6h2.1l1.5-4 2.5 7.2 1.5-3.2h3.9',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 16x16 counter-clockwise arrow glyph for the "undo last step" button. */
    function UndoIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', {
          d: 'M6.2 4.2 3 7.4l3.2 3.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.3 7.4h5.4a3.5 3.5 0 0 1 0 7h-1.3',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * Build the panel component for one plugin apply invocation.
     * @param ctx - Client plugin context (services resolved lazily per action).
     */
    function createPanel(ctx) {
      /** Run one slash command for the given session; never throws. */
      async function executeCommand(sessionId, command, payload) {
        const remote = ctx.get('remote.commands')
        if (remote === undefined || typeof remote.execute !== 'function') {
          return { ok: false, error: { code: 'unavailable', message: null } }
        }
        const line = payload ? '/' + command + ' ' + payload : '/' + command
        return await remote.execute(sessionId, line, [])
      }

      return function PhotoshopGenfillPanel(props) {
        const sessionId = props.sessionId
        const t = typeof props.t === 'function' ? props.t : function fallback(key) { return key }

        const [mode, setMode] = React.useState('fill')
        const [text, setText] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [busySeconds, setBusySeconds] = React.useState(0)
        const [psState, setPsState] = React.useState('idle')
        /** { kind: 'success' | 'error', text?: string, key?: string } */
        const [notice, setNotice] = React.useState(null)

        const busyRef = React.useRef(false)
        const busyStartRef = React.useRef(0)
        const aliveRef = React.useRef(true)

        React.useEffect(function trackAlive() {
          aliveRef.current = true
          return function markDead() {
            aliveRef.current = false
          }
        }, [])

        // Elapsed-seconds readout while a command runs (image generation can take minutes).
        React.useEffect(function trackElapsed() {
          if (!busy) return undefined
          busyStartRef.current = Date.now()
          setBusySeconds(0)
          const timer = setInterval(function tick() {
            setBusySeconds(Math.floor((Date.now() - busyStartRef.current) / 1000))
          }, 1000)
          return function stopTick() {
            clearInterval(timer)
          }
        }, [busy])

        const activeMode = MODES.find(function findMode(item) { return item.id === mode }) || MODES[0]
        const trimmed = text.trim()
        const canSubmit = !busy && trimmed.length > 0 && typeof sessionId === 'string'

        function describeFailure(error) {
          if (error === undefined || error === null) return t('error.unknown')
          if (typeof error === 'string') return error
          const message = typeof error.message === 'string' ? error.message : ''
          const code = typeof error.code === 'string' ? error.code : ''
          if (message) return message
          if (code) return code
          return t('error.unknown')
        }

        // Return { kind, text?, key? } for one RemoteResult.
        function readOutcome(result) {
          if (result !== undefined && result !== null && result.ok === true) {
            const value = result.value
            const outcome = value && value.result
            if (outcome && outcome.kind === 'success') {
              const resultText = typeof outcome.text === 'string' ? outcome.text : ''
              if (resultText) return { kind: 'success', text: resultText }
              return { kind: 'success', key: 'result.ok' }
            }
            if (outcome && outcome.kind === 'error') {
              const resultText = typeof outcome.text === 'string' ? outcome.text : ''
              if (resultText) return { kind: 'error', text: resultText }
              return { kind: 'error', key: 'error.unknown' }
            }
            return { kind: 'error', key: 'error.unknown' }
          }
          if (result !== undefined && result !== null && result.ok === false) {
            const error = result.error
            if (error && error.code === 'unavailable' && !error.message) {
              return { kind: 'error', key: 'error.unavailable' }
            }
            return { kind: 'error', text: describeFailure(error) }
          }
          return { kind: 'error', key: 'error.unknown' }
        }

        async function run(command, payload) {
          if (busyRef.current || typeof sessionId !== 'string') return
          busyRef.current = true
          setBusy(true)
          setBusySeconds(0)
          setNotice(null)
          let next
          try {
            const result = await executeCommand(sessionId, command, payload)
            next = readOutcome(result)
          } catch (error) {
            next = { kind: 'error', text: describeFailure(error) }
          }
          busyRef.current = false
          if (!aliveRef.current) return
          setBusy(false)
          setPsState(next.kind === 'error' ? 'error' : 'ready')
          setNotice(next)
          if (next.kind !== 'error' && payload) setText('')
        }

        function onSubmit(event) {
          if (event !== undefined) event.preventDefault()
          if (!canSubmit) return
          run(activeMode.command, trimmed)
        }

        function submitFromKeyboard(event) {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          onSubmit()
        }

        function onRootKeyDown(event) {
          if (event.key === 'Escape' && notice !== null && !busy) {
            setNotice(null)
          }
        }

        const dotLabel = t('status.label.' + psState)
        const resultText = notice === null ? '' : notice.text !== undefined ? notice.text : t(notice.key)
        const runLabel = t('action.run.' + mode)
        const placeholder = t('prompt.placeholder.' + mode)

        return h(
          'div',
          {
            className: 'psg-root',
            role: 'group',
            'aria-label': t('panel.aria'),
            'data-ps-genfill': 'true',
            'data-busy': busy ? 'true' : 'false',
            onKeyDown: onRootKeyDown,
          },
          h('style', { key: 'style' }, STYLE),
          h(
            'div',
            { className: 'psg-row', key: 'row', 'data-busy': busy ? 'true' : 'false' },
            h('span', {
              className: 'psg-dot',
              key: 'dot',
              'data-state': psState,
              role: 'img',
              'aria-label': dotLabel,
              title: dotLabel,
            }),
            h('span', { className: 'psg-label', key: 'label' }, t('panel.label')),
            h('span', { className: 'psg-divider', key: 'divider', 'aria-hidden': true }),
            h(
              'span',
              { className: 'psg-mode', key: 'mode' },
              h(
                'select',
                {
                  className: 'psg-select',
                  value: mode,
                  disabled: busy,
                  'aria-label': t('mode.aria'),
                  title: t('mode.aria'),
                  onChange: function onModeChange(event) {
                    setMode(event.target.value)
                  },
                },
                MODES.map(function modeOption(item) {
                  return h('option', { key: item.id, value: item.id }, t('mode.' + item.id))
                }),
              ),
            ),
            h('input', {
              key: 'input',
              className: 'psg-input',
              type: 'text',
              value: text,
              disabled: busy,
              placeholder: placeholder,
              'aria-label': t('prompt.aria'),
              autoComplete: 'off',
              spellCheck: false,
              enterKeyHint: 'send',
              onChange: function onTextChange(event) {
                setText(event.target.value)
              },
              onKeyDown: submitFromKeyboard,
            }),
            h(
              'button',
              {
                key: 'submit',
                type: 'button',
                className: 'psg-primary',
                disabled: !canSubmit,
                onClick: onSubmit,
                'aria-label': runLabel,
                title: runLabel,
              },
              busy ? h('span', { className: 'psg-spinner', 'aria-hidden': true }) : null,
              h('span', null, busy ? t('action.busy') : runLabel),
            ),
            h(
              'button',
              {
                key: 'status',
                type: 'button',
                className: 'psg-iconBtn',
                disabled: busy,
                'aria-label': t('action.status'),
                title: t('action.status'),
                onClick: function onStatusClick() {
                  run('psstatus', '')
                },
              },
              h(StatusIcon),
            ),
            h(
              'button',
              {
                key: 'undo',
                type: 'button',
                className: 'psg-iconBtn',
                disabled: busy,
                'aria-label': t('action.undo'),
                title: t('action.undo'),
                onClick: function onUndoClick() {
                  run('psundo', '')
                },
              },
              h(UndoIcon),
            ),
          ),
          busy || notice !== null
            ? h(
                'div',
                {
                  key: 'result',
                  className: 'psg-result',
                  'data-kind': busy ? 'info' : notice.kind,
                  role: notice !== null && notice.kind === 'error' ? 'alert' : 'status',
                  'aria-live': notice !== null && notice.kind === 'error' ? 'assertive' : 'polite',
                },
                busy
                  ? h('span', { className: 'psg-spinner', 'aria-hidden': true })
                  : h('span', {
                      className: 'psg-dot',
                      'data-state': notice.kind === 'error' ? 'error' : 'ready',
                      'aria-hidden': true,
                      style: { width: '5px', height: '5px' },
                    }),
                h(
                  'span',
                  { className: 'psg-resultText', title: busy ? undefined : resultText },
                  busy ? t('status.busy') : resultText,
                ),
                busy
                  ? h('span', { className: 'psg-elapsed', 'aria-hidden': true }, t('status.elapsed', { seconds: busySeconds }))
                  : notice !== null
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'psg-dismiss',
                          'aria-label': t('action.dismiss'),
                          title: t('action.dismiss'),
                          onClick: function onDismiss() {
                            setNotice(null)
                          },
                        },
                        h('span', { 'aria-hidden': true }, '×'),
                      )
                    : null,
              )
            : null,
        )
      }
    }

    return {
      inject: ['slots', 'locale', 'remote.commands'],
      apply(ctx) {
        ctx.effect(
          function registerDictionaries() {
            return ctx.locale.register(NS, { zh, en })
          },
          'ps-genfill: dictionaries',
        )
        const Panel = createPanel(ctx)
        ctx.slots.inject('conversation.composer.dock', function registerDockEntry() {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'ps-genfill',
              order: 6,
              locale: NS,
            },
            Panel,
          )
        })
      },
    }
  },
})
