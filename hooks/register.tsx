/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ProcessRunInit, ProcessRunResult, Register, RenderElement, ToastOptions } from 'claude-code'

type Issue = {
  key: string
  missing?: true
  summary?: string
  status?: string
  original_seconds?: number
  spent_seconds?: number
  remaining_seconds?: number
  url?: string
}

type Snapshot = {
  error?: string
  today_seconds?: number
  week_seconds?: number
  deployed?: {
    seconds: number
    pending_seconds: number
    min_seconds: number
    max_seconds: number
    window_end: string
  }
  issue?: Issue | null
  fetched_at?: string
}

type Stack = { container: string | null; isViteUp: boolean }

type Host = {
  run: (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  now: () => Promise<number>
  invalidate: () => void
  status: (text: string | undefined) => void
  toast: (text: string, options?: ToastOptions) => void
}

const SNAPSHOT_SCRIPT = '/Users/facundo/.claude/local-plugins/claude-code-hud/bin/snapshot.py'
const ADMIN_PATH = '/Users/facundo/Sites/admin'
const CONTAINER = 'admin-web-interface-1'
const DAY_TARGET_SECONDS = 6 * 3600
const WEEK_TARGET_SECONDS = 30 * 3600
const JIRA_EVERY_MS = 5 * 60_000
const JIRA_MIN_GAP_MS = 2 * 60_000
const STACK_EVERY_MS = 30_000
const HIDDEN_KEY = 'hidden'
const TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/

// Ghostty's Monokai Pro palette; bars use the same hues blended 20% toward the background
const THEME = {
  border: '#5b595c',
  title: '#c1c0c0',
  accent: '#78dce8',
  highlight: '#ffd866',
  red: '#ff6188',
  orange: '#fc9867',
  yellow: '#ffd866',
  green: '#a9dc76',
  purple: '#ab9df2',
}
const BAR = {
  track: '#403e41',
  red: '#d55676',
  orange: '#d3825c',
  yellow: '#d5b55b',
  green: '#90b868',
  purple: '#9286cb',
}
const BAR_GLYPH = '▄'

type Tone = 'red' | 'orange' | 'yellow' | 'green' | 'purple'

export const register: Register = on => {
  let engine: Host | null = null
  let cwd = ''
  let branch = ''
  let isDirty = false
  let snapshot: Snapshot | null = null
  let stack: Stack | null = null
  let jiraFetchedAt = 0
  let isJiraLoading = false
  let isJiraRefreshQueued = false
  let isHidden = false
  let running: string | null = null

  const redraw = () => engine?.invalidate()
  const isAdmin = () => cwd === ADMIN_PATH
  const ticketKey = () => branch.match(TICKET_PATTERN)?.[1] ?? null

  async function refreshBranch() {
    if (!engine) return
    const { exitCode, stdout } = await engine
      .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
      .catch(() => ({ exitCode: 1, stdout: '' }))
    const next = exitCode === 0 ? stdout.trim() : ''
    const porcelain = await engine
      .run(['git', 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 5_000 })
      .catch(() => ({ exitCode: 1, stdout: '' }))
    const wasDirty = isDirty
    isDirty = porcelain.exitCode === 0 && porcelain.stdout.trim() !== ''
    if (wasDirty !== isDirty || next !== branch) redraw()
    const hasTicketChanged = next.match(TICKET_PATTERN)?.[1] !== ticketKey()
    branch = next
    if (hasTicketChanged) void refreshJira(true)
  }

  async function refreshStack() {
    if (!engine || !isAdmin()) return
    const [ps, hot] = await Promise.all([
      engine
        .run(['docker', 'ps', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Status}}'], { timeoutMs: 8_000 })
        .catch(() => ({ exitCode: 1, stdout: '' })),
      engine
        .run(['test', '-f', `${ADMIN_PATH}/public/hot`], { timeoutMs: 3_000 })
        .catch(() => ({ exitCode: 1, stdout: '' })),
    ])
    stack = { container: ps.stdout.trim() || null, isViteUp: hot.exitCode === 0 }
    redraw()
  }

  async function refreshJira(force = false) {
    if (!engine) return
    // A forced refresh during a fetch usually means the ticket changed, so the running fetch is already stale
    if (isJiraLoading) {
      isJiraRefreshQueued ||= force
      return
    }
    const now = await engine.now()
    if (!force && now - jiraFetchedAt < JIRA_MIN_GAP_MS) return

    isJiraLoading = true
    redraw()
    const key = ticketKey()
    try {
      const { stdout } = await engine.run(
        ['python3', SNAPSHOT_SCRIPT, ...(key ? ['--issue', key] : [])],
        { timeoutMs: 60_000 },
      )
      snapshot = JSON.parse(stdout) as Snapshot
    } catch (error) {
      snapshot = { error: error instanceof Error ? error.message : String(error) }
    } finally {
      jiraFetchedAt = now
      isJiraLoading = false
      redraw()
    }
    if (isJiraRefreshQueued) {
      isJiraRefreshQueued = false
      void refreshJira(true)
    }
  }

  async function runPest() {
    if (!engine || running) return
    running = 'pest'
    engine.status('pest corriendo en el container…')
    redraw()
    try {
      const { exitCode, stdout } = await engine.run(
        ['docker', 'exec', CONTAINER, './vendor/bin/pest', '--parallel', '--processes=6'],
        { timeoutMs: 600_000 },
      )
      const summary = stdout.match(/Tests:\s+(.+)/)?.[1]?.trim() ?? `exit ${exitCode}`
      engine.toast(`pest: ${summary}`, { timeoutMs: 15_000 })
      await engine
        .run(['docker', 'exec', CONTAINER, 'php', 'artisan', 'optimize:clear'], { timeoutMs: 60_000 })
        .catch(() => undefined)
    } catch (error) {
      engine.toast(`pest no terminó: ${error instanceof Error ? error.message : error}`)
    } finally {
      running = null
      engine.status(undefined)
      redraw()
    }
  }

  async function runCsFixer() {
    if (!engine || running) return
    running = 'cs-fixer'
    redraw()
    try {
      const [changed, untracked] = await Promise.all([
        engine.run(['git', 'diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
        engine.run(['git', 'ls-files', '--others', '--exclude-standard']),
      ])
      const files = [...new Set(`${changed.stdout}\n${untracked.stdout}`.split('\n'))]
        .map(file => file.trim())
        .filter(file => file.endsWith('.php'))

      if (files.length === 0) {
        engine.toast('cs-fixer: no hay PHP modificados')
        return
      }

      const { exitCode, stdout, stderr } = await engine.run(
        ['docker', 'exec', CONTAINER, './vendor/bin/php-cs-fixer', 'fix', ...files],
        { timeoutMs: 180_000 },
      )
      if (exitCode !== 0) {
        const reason = (stderr.trim() || stdout.trim()).split('\n').pop() || `exit ${exitCode}`
        engine.toast(`cs-fixer falló: ${reason}`, { timeoutMs: 15_000 })
        return
      }
      const fixed = stdout.match(/^\s*\d+\)/gm)?.length ?? 0
      engine.toast(`cs-fixer: ${files.length} revisados, ${fixed} corregidos`, { timeoutMs: 8_000 })
    } catch (error) {
      engine.toast(`cs-fixer falló: ${error instanceof Error ? error.message : error}`)
    } finally {
      running = null
      redraw()
    }
  }

  function openTicket() {
    const url = snapshot?.issue?.url
    if (engine && url) void engine.run(['open', url]).catch(() => undefined)
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result

    engine = {
      run: (argv, init) => $.process.run(argv, init),
      now: () => Promise.resolve($.clock.now()),
      invalidate: () => $.ui.invalidate('ui.render'),
      status: text => $.ui.status(text),
      toast: (text, options) => $.ui.toast(text, options),
    }
    cwd = e.cwd
    isHidden = (await $.store.get(HIDDEN_KEY).catch(() => false)) === true

    await $.command.register({
      name: 'hud',
      description: 'Muestra u oculta el HUD de Jira; /hud refresh vuelve a consultar',
      argumentHint: '[refresh]',
      immediate: true,
    })

    void refreshBranch().then(() => refreshJira(true))
    void refreshStack()
    $.clock.every(JIRA_EVERY_MS, () => void refreshJira())
    $.clock.every(STACK_EVERY_MS, () => {
      void refreshBranch()
      void refreshStack()
    })

    return result
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    if (e.args.trim() === 'refresh') {
      void refreshBranch().then(() => refreshJira(true))
      void refreshStack()
      return { text: 'HUD: consultando Jira…' }
    }

    isHidden = !isHidden
    await $.store.set(HIDDEN_KEY, isHidden).catch(() => undefined)
    redraw()
    return { text: isHidden ? 'HUD oculto' : 'HUD visible' }
  })

  on('turn.complete', ($, e, next) => {
    void refreshBranch()
    void refreshStack()
    void refreshJira()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isHidden || e.surface !== 'terminal' || e.props.hasSurvey || !engine) {
      return next(e)
    }

    const { Box, Text, Button } = await $.ui.resolve(e)
    const [usage, model, settings] = await Promise.all([
      $.session.usage().catch(() => null),
      $.session.model().catch(() => ''),
      $.settings.read().catch(() => ({}) as Record<string, unknown>),
    ])
    const now = await $.clock.now()
    const effort = typeof settings.effortLevel === 'string' ? settings.effortLevel : ''

    const columns = (e.viewport?.columns ?? 100) - 2
    const isRow = columns >= 140
    const weights = [1.4, 1.0, 0.8, 1.3]
    const cardWidths = isRow
      ? weights.map(weight => Math.floor(((columns - 3) * weight) / 4.5))
      : weights.map(() => Math.floor((columns - 1) / 2))
    const innerOf = (index: number) => cardWidths[index] - 4

    const card = (index: number, title: string, children: RenderElement[]): RenderElement => (
      <Box
        key={title}
        flexDirection="column"
        width={cardWidths[index]}
        borderStyle="round"
        borderColor={THEME.border}
        paddingX={1}
      >
        <Text bold color={THEME.title}>{title}</Text>
        {children}
      </Box>
    )

    const bar = (ratio: number, width: number, color: string): RenderElement => {
      const filled = clamp(Math.round((Number.isFinite(ratio) ? ratio : 0) * width), 0, width)
      return (
        <Text>
          <Text color={color}>{BAR_GLYPH.repeat(filled)}</Text>
          <Text color={BAR.track}>{BAR_GLYPH.repeat(width - filled)}</Text>
        </Text>
      )
    }

    const branchLine = (): RenderElement => (
      <Text wrap="truncate-end">
        <Text bold color={THEME.accent}>{cwd.split('/').pop()}</Text>
        <Text dimColor> ({branch || 'sin git'}</Text>
        {isDirty && <Text color={THEME.yellow}>*</Text>}
        <Text dimColor>)</Text>
      </Text>
    )

    const ticketCard = (): RenderElement => {
      const key = ticketKey()
      if (!key) {
        return card(0, 'TICKET', [
          branchLine(),
          <Text dimColor wrap="truncate-end">el branch no nombra un ticket</Text>,
        ])
      }

      const issue = snapshot?.issue?.key === key ? snapshot.issue : null
      if (!issue) return card(0, 'TICKET', [<Text dimColor>{key} · cargando…</Text>])
      if (issue.missing) return card(0, 'TICKET', [<Text color={THEME.red}>{key} · no existe en Jira</Text>])

      const original = issue.original_seconds ?? 0
      const spent = issue.spent_seconds ?? 0
      const isOver = original > 0 && spent > original
      const figures = original
        ? `${duration(spent)}/${duration(original)} · resta ${duration(issue.remaining_seconds ?? 0)}`
        : `${duration(spent)} sin estimate`
      const barWidth = clamp(innerOf(0) - figures.length - 1, 4, 20)

      return card(0, 'TICKET', [
        <Text wrap="truncate-end">
          <Text bold color={THEME.accent}>{key}</Text>
          <Text color={statusColor(issue.status ?? '')}>  ◆ {issue.status?.toLowerCase()}</Text>
        </Text>,
        <Text bold wrap="truncate-end">{issue.summary}</Text>,
        <Text wrap="truncate-end">
          {original > 0 && (
            <Text>{bar(spent / original, barWidth, isOver ? BAR.red : BAR.green)} </Text>
          )}
          <Text color={isOver ? THEME.red : undefined} dimColor={!isOver}>{figures}</Text>
        </Text>,
        branchLine(),
      ])
    }

    const timeCard = (): RenderElement => {
      if (snapshot?.error) {
        return card(1, 'TIEMPO', [<Text color={THEME.red} wrap="truncate-end">Jira: {snapshot.error}</Text>])
      }
      if (!snapshot?.deployed) return card(1, 'TIEMPO', [<Text dimColor>Jira: cargando…</Text>])

      const today = snapshot.today_seconds ?? 0
      const week = snapshot.week_seconds ?? 0
      const { seconds, min_seconds: min, max_seconds: max, pending_seconds: pending } = snapshot.deployed
      const deployedColor: Tone = seconds < min ? 'red' : seconds > max ? 'yellow' : 'green'
      const deployedNote = seconds < min ? `faltan ${duration(min - seconds)}` : seconds > max ? `+${duration(seconds - max)}` : 'en rango'
      const barWidth = clamp(innerOf(1) - 19, 4, 14)

      return card(1, 'TIEMPO', [
        <Text wrap="truncate-end">
          <Text dimColor>hoy     </Text>
          {bar(today / DAY_TARGET_SECONDS, barWidth, BAR.green)}
          <Text bold> {duration(today)}</Text>
          {today >= DAY_TARGET_SECONDS && <Text color={THEME.green}> ✓</Text>}
        </Text>,
        <Text wrap="truncate-end">
          <Text dimColor>semana  </Text>
          {bar(week / WEEK_TARGET_SECONDS, barWidth, BAR.yellow)}
          <Text bold> {duration(week)}</Text>
          <Text dimColor>/{duration(WEEK_TARGET_SECONDS)}</Text>
        </Text>,
        <Text wrap="truncate-end">
          <Text dimColor>deploy  </Text>
          {bar(seconds / max, barWidth, BAR[deployedColor])}
          <Text color={THEME[deployedColor]}> {duration(seconds)}</Text>
          <Text dimColor>/24–30h</Text>
        </Text>,
        <Text wrap="truncate-end">
          <Text color={THEME.yellow}>⏱ {duration(pending)} en curso</Text>
          <Text dimColor> · {deployedNote}</Text>
        </Text>,
      ])
    }

    const envCard = (): RenderElement => {
      const fetchedAt = snapshot?.fetched_at?.slice(11, 16)
      const rows: RenderElement[] = []
      if (isAdmin() && stack) {
        rows.push(
          <Text wrap="truncate-end">
            <Text color={stack.container ? THEME.green : THEME.red}>●</Text>
            <Text> container  </Text>
            <Text color={stack.isViteUp ? THEME.green : THEME.border}>●</Text>
            <Text> vite</Text>
          </Text>,
        )
      }
      if (isAdmin()) {
        rows.push(
          <Box flexDirection="row" gap={1}>
            <Button key="pest" hotkey="t" label={running === 'pest' ? 'pest…' : 'pest'} onPress={() => void runPest()} />
            <Button
              key="cs-fixer"
              hotkey="f"
              label={running === 'cs-fixer' ? 'fixer…' : 'fixer'}
              onPress={() => void runCsFixer()}
            />
          </Box>,
        )
      }
      rows.push(
        <Box flexDirection="row" gap={1}>
          {snapshot?.issue?.url && <Button key="ticket" hotkey="o" label="ticket" onPress={openTicket} />}
          <Button key="refresh" hotkey="r" label={isJiraLoading ? '↻…' : '↻'} onPress={() => void refreshJira(true)} />
          {fetchedAt && <Text dimColor>{fetchedAt}</Text>}
        </Box>,
      )
      return card(2, 'ENTORNO', rows)
    }

    const claudeCard = (): RenderElement => {
      const barWidth = clamp(innerOf(3) - 31, 4, 12)
      const meter = (
        label: string,
        percent: number | undefined,
        color: Tone,
        window?: { resetsAt?: string; seconds: number },
      ): RenderElement => {
        const used = percent ?? 0
        const forecast = window?.resetsAt ? pace(used, window.resetsAt, window.seconds, now) : null
        return (
          <Text wrap="truncate-end">
            <Text dimColor>{label}</Text>
            {bar(used / 100, barWidth, BAR[color])}
            <Text color={THEME[color]}> {String(Math.round(used)).padStart(2)}%</Text>
            {window?.resetsAt && <Text dimColor> ↻{untilReset(window.resetsAt, now)}</Text>}
            {forecast && <Text color={forecast.color && THEME[forecast.color]} dimColor={!forecast.color}> {forecast.text}</Text>}
          </Text>
        )
      }
      const limit = (kind: string) => usage?.rateLimits.find(window => window.kind === kind)
      const session = limit('five_hour')
      const weekly = limit('seven_day')

      return card(3, 'CLAUDE', [
        <Text wrap="truncate-end">
          <Text bold color={THEME.highlight}>{modelName(model)}</Text>
          {effort && <Text dimColor> · </Text>}
          {effort && <Text color={effortColor(effort)}>{effort}</Text>}
        </Text>,
        meter('ctx  ', usage?.context.percent, contextColor(usage?.context.percent ?? 0)),
        ...(session
          ? [meter('5h   ', session.percentUsed, meterColor(session.percentUsed), { resetsAt: session.resetsAt, seconds: 5 * 3600 })]
          : []),
        ...(weekly
          ? [meter('sem  ', weekly.percentUsed, meterColor(weekly.percentUsed), { resetsAt: weekly.resetsAt, seconds: 7 * 86400 })]
          : []),
      ])
    }

    const cards = [ticketCard(), timeCard(), envCard(), claudeCard()]

    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {isRow ? (
          <Box flexDirection="row" gap={1}>{cards}</Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>{cards.slice(0, 2)}</Box>
            <Box flexDirection="row" gap={1}>{cards.slice(2)}</Box>
          </Box>
        )}
      </Box>
    )
  })
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return minutes ? `${hours}h${String(minutes).padStart(2, '0')}` : `${hours}h`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function meterColor(percent: number): Tone {
  if (percent >= 80) return 'red'
  if (percent >= 40) return 'yellow'
  return 'green'
}

// Aggressive on purpose, to prompt compacting before the window fills
function contextColor(percent: number): Tone {
  if (percent >= 65) return 'red'
  if (percent >= 45) return 'orange'
  if (percent >= 25) return 'yellow'
  return 'green'
}

function effortColor(effort: string): string | undefined {
  if (effort === 'low') return THEME.green
  if (effort === 'medium') return THEME.yellow
  if (effort === 'high') return THEME.red
  if (effort === 'xhigh' || effort === 'max') return THEME.purple
  return undefined
}

function pace(used: number, resetsAt: string, windowSeconds: number, now: number): { text: string; color?: Tone } | null {
  const left = (Date.parse(resetsAt) - now) / 1000
  if (!Number.isFinite(left) || left <= 0 || left > windowSeconds) return null
  const elapsed = windowSeconds - left
  const expected = (elapsed / windowSeconds) * 100
  if (expected < 3) return null

  const actual = clamp(used, 0, 100)
  const delta = actual - expected
  const rate = actual / elapsed
  const eta = actual > 0 && (100 - actual) / rate < left ? `out ${compact((100 - actual) / rate)}` : 'lasts'
  if (Math.abs(delta) <= 2) return { text: `• ${eta}` }
  return delta > 0
    ? { text: `▴${Math.round(delta)}% ${eta}`, color: 'yellow' }
    : { text: `▾${Math.round(-delta)}% ${eta}`, color: 'green' }
}

function compact(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
  return `${minutes}m`
}

function untilReset(resetsAt: string, now: number): string {
  return compact(Math.max(0, (Date.parse(resetsAt) - now) / 1000))
}

function modelName(model: string): string {
  const match = model.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i)
  if (!match) return model || 'Claude'
  const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
  const version = match[3] && match[3].length <= 2 ? `${match[2]}.${match[3]}` : match[2]
  return `${family} ${version}${/\[1m\]/i.test(model) ? ' 1M' : ''}`
}

function statusColor(status: string): string | undefined {
  const normalized = status.toLowerCase()
  if (normalized.includes('deployed') || normalized.includes('done')) return THEME.green
  if (normalized.includes('review')) return THEME.purple
  if (normalized.includes('progress')) return THEME.yellow
  return undefined
}
