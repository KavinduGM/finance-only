import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { DatabaseBackup, Download, FileUp, RotateCcw, Trash2, X } from 'lucide-react'
import { backupApi, settingsApi } from '../../services/api'
import type { BackupFile, SystemInfo } from '../../services/api'
import { EmptyState, ErrorState, LoadingBlock, Spinner, TableSkeleton, useConfirm } from '../../components/ui'
import { downloadUrl } from '../../lib/files'
import { errorMessage, formatDateTime, formatNumber } from '../../lib/format'
import { Notice, Section } from './shared'

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/** What kind of backup a stored file is, from the prefix the server gives its name. */
function backupType(name: string) {
  if (name.startsWith('auto-')) return 'Automatic daily'
  if (name.startsWith('manual-')) return 'Manual'
  if (name.startsWith('pre-restore-')) return 'Before a restore'
  if (name.startsWith('pre-upgrade-')) return 'Before upgrade'
  return 'Other'
}

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${formatNumber(mb, mb >= 100 ? 0 : 1)} MB`
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`
}

type RestoreResult = Awaited<ReturnType<typeof backupApi.restoreStored>>

/** Backups of the database, restoring one, and a few facts about the installation. Administrators only. */
export default function BackupTab({ active }: { active: boolean }) {
  const confirm = useConfirm()

  const [list, setList] = useState<{ backups: BackupFile[]; keep: number } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const listTicket = useRef(0)

  // The download is a plain browser download with no answer to wait for, so the
  // button is held for a few seconds: a double click must not start two of them.
  const [downloading, setDownloading] = useState(false)
  const downloadTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (downloadTimer.current !== null) window.clearTimeout(downloadTimer.current)
  }, [])

  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [systemError, setSystemError] = useState<string | null>(null)

  const picker = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)

  // After a restore: the server is restarting by itself, or it is waiting for someone to restart it.
  const [restarting, setRestarting] = useState(false)
  const [slowRestart, setSlowRestart] = useState(false)
  const [pendingRestart, setPendingRestart] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    const mine = ++listTicket.current
    setListError(null)
    try {
      const res = await backupApi.list()
      if (mine === listTicket.current) setList(res)
    } catch (err) {
      if (mine !== listTicket.current) return
      setList(null)
      setListError(errorMessage(err, 'Could not load the backups'))
    }
  }, [])

  const loadSystem = useCallback(async () => {
    setSystemError(null)
    try {
      setSystem(await settingsApi.system())
    } catch (err) {
      setSystem(null)
      setSystemError(errorMessage(err, 'Could not load the system information'))
    }
  }, [])

  useEffect(() => {
    if (!active) return
    loadList()
    loadSystem()
  }, [active, loadList, loadSystem])

  // While the server restarts, ask every 2 seconds whether it is back, then
  // reload so the app starts again on the restored data.
  useEffect(() => {
    if (!restarting) return
    const started = Date.now()
    let wentDown = false
    let waiting = false
    let stopped = false

    const timer = window.setInterval(async () => {
      if (Date.now() - started > 60000) setSlowRestart(true)
      if (waiting) return
      waiting = true
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (stopped) return
        // An answer from the old process, in the moment before it stops, does not count.
        if (res.ok && (wentDown || Date.now() - started > 6000)) window.location.reload()
        else if (!res.ok) wentDown = true
      } catch {
        wentDown = true
      } finally {
        waiting = false
      }
    }, 2000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [restarting])

  function afterRestore(res: RestoreResult) {
    if (res.restarting) {
      setRestarting(true)
    } else {
      // This server does not restart itself; the restore waits for the next start.
      setPendingRestart(res.message)
      toast.success(res.message)
    }
  }

  const restoreWarning = (source: React.ReactNode) => (
    <>
      <p>
        <strong className="text-ink font-semibold">All current data is replaced</strong> by {source}: clients, proposals,
        invoices, income, expenses, payroll, settings and user accounts.
      </p>
      <ul className="list-disc pl-5 mt-3 space-y-1.5">
        <li>The current database is saved first as a "Before a restore" backup.</li>
        <li>The system restarts, which takes a few seconds.</li>
        <li>Everyone has to sign in again, with the accounts stored in the backup.</li>
      </ul>
    </>
  )

  async function createBackup() {
    setCreating(true)
    try {
      await backupApi.create()
      toast.success('Backup created on the server')
      await loadList()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not create the backup'))
    } finally {
      setCreating(false)
    }
  }

  function downloadNow() {
    if (downloadTimer.current !== null) return
    setDownloading(true)
    downloadUrl(backupApi.downloadUrl())
    downloadTimer.current = window.setTimeout(() => {
      downloadTimer.current = null
      setDownloading(false)
    }, 3000)
  }

  async function restoreStored(backup: BackupFile) {
    const ok = await confirm({
      title: 'Restore this backup?',
      message: restoreWarning(<>the backup from {formatDateTime(backup.created_at)}</>),
      confirmLabel: 'Replace all data',
      tone: 'danger',
    })
    if (!ok) return

    setBusyName(backup.name)
    try {
      afterRestore(await backupApi.restoreStored(backup.name))
    } catch (err) {
      toast.error(errorMessage(err, 'Could not restore the backup'))
    } finally {
      setBusyName(null)
    }
  }

  async function removeBackup(backup: BackupFile) {
    const ok = await confirm({
      title: 'Delete this backup?',
      message: <>The file <span className="num text-ink break-all">{backup.name}</span> is removed from the server. This cannot be undone.</>,
      confirmLabel: 'Delete backup',
      tone: 'danger',
    })
    if (!ok) return

    setBusyName(backup.name)
    try {
      await backupApi.delete(backup.name)
      toast.success('Backup deleted')
      setList((current) => (current ? { ...current, backups: current.backups.filter((b) => b.name !== backup.name) } : current))
      loadList()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the backup'))
    } finally {
      setBusyName(null)
    }
  }

  function chooseFile(chosen: File) {
    if (!/\.db$/i.test(chosen.name)) {
      toast.error('Choose a backup file that ends in .db')
      return
    }
    if (chosen.size === 0) {
      toast.error('That file is empty')
      return
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      toast.error('That file is too large. The limit is 200 MB.')
      return
    }
    setFile(chosen)
  }

  async function restoreUpload() {
    if (!file || uploading) return
    const ok = await confirm({
      title: 'Restore from this file?',
      message: restoreWarning(<>the contents of <span className="num text-ink break-all">{file.name}</span></>),
      confirmLabel: 'Replace all data',
      tone: 'danger',
    })
    if (!ok) return

    setUploading(true)
    try {
      const res = await backupApi.restoreUpload(file)
      setFile(null)
      afterRestore(res)
    } catch (err) {
      toast.error(errorMessage(err, 'Could not restore from the file'))
    } finally {
      setUploading(false)
    }
  }

  if (restarting) {
    return (
      <div className="card">
        <div className="flex flex-col items-center justify-center text-center py-20 px-6" role="status" aria-live="polite">
          <Spinner size={22} className="text-accent" />
          <p className="mt-4 text-base font-semibold text-ink">Restarting…</p>
          <p className="mt-1.5 text-sm text-ink-3 max-w-md">
            The system is starting again with the restored data. This page reloads on its own when it is ready. Sign in
            again with an account from the backup.
          </p>
          {slowRestart && (
            <>
              <p className="mt-5 text-sm text-ink-2 max-w-md">
                This is taking longer than usual. If the server is not set up to restart by itself, start it again, then reload.
              </p>
              <button type="button" className="btn-secondary mt-3" onClick={() => window.location.reload()}>
                Reload now
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const keep = list?.keep
  const restoreDisabled = busyName !== null || uploading

  return (
    <div className="space-y-5">
      {pendingRestart && (
        <Notice tone="warn" alert>
          {pendingRestart} Until then the system keeps running on the current data, and anything entered now is replaced when it restarts.
        </Notice>
      )}

      <Section
        flush
        title="Backups"
        description="A backup is a copy of the whole database: clients, proposals, invoices, income, expenses, payroll, settings and user accounts. Uploaded receipts and the logo are files in the data volume and are not inside the .db file."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={createBackup} disabled={creating}>
              {creating ? <Spinner /> : <DatabaseBackup size={15} />} Create backup on server
            </button>
            <button type="button" className="btn-primary" onClick={downloadNow} disabled={downloading}>
              {downloading ? <Spinner /> : <Download size={15} />} Download backup now
            </button>
          </>
        }
      >
        {listError ? (
          <ErrorState message={listError} onRetry={loadList} />
        ) : list === null ? (
          <TableSkeleton rows={4} cols={4} />
        ) : list.backups.length === 0 ? (
          <EmptyState
            icon={DatabaseBackup}
            title="No backups stored yet"
            description="The first automatic backup is made at 02:00. You can also create one now."
            action={
              <button type="button" className="btn-secondary" onClick={createBackup} disabled={creating}>
                {creating ? <Spinner /> : <DatabaseBackup size={15} />} Create backup on server
              </button>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="th">Name</th>
                  <th scope="col" className="th">Type</th>
                  <th scope="col" className="th-num">Size</th>
                  <th scope="col" className="th">Created</th>
                  <th scope="col" className="th-num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.backups.map((b) => {
                  const busy = busyName === b.name
                  return (
                    <tr key={b.name} className="tr">
                      <td className="td td-strong">
                        <span className="num block max-w-[340px] truncate" title={b.name}>{b.name}</span>
                      </td>
                      <td className="td whitespace-nowrap">{backupType(b.name)}</td>
                      <td className="td-num whitespace-nowrap">{formatSize(b.size)}</td>
                      <td className="td whitespace-nowrap">{formatDateTime(b.created_at)}</td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-0.5">
                          {busy && <Spinner size={14} className="text-ink-3 mr-1" />}
                          <button
                            type="button" className="btn-icon" disabled={busy}
                            onClick={() => downloadUrl(backupApi.storedUrl(b.name))}
                            title="Download" aria-label={`Download ${b.name}`}
                          >
                            <Download size={15} />
                          </button>
                          <button
                            type="button" className="btn-icon" disabled={restoreDisabled}
                            onClick={() => restoreStored(b)}
                            title="Restore this backup" aria-label={`Restore ${b.name}`}
                          >
                            <RotateCcw size={15} />
                          </button>
                          <button
                            type="button" className="btn-icon-danger" disabled={busyName !== null}
                            onClick={() => removeBackup(b)}
                            title="Delete" aria-label={`Delete ${b.name}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {keep !== undefined && (
          <p className="px-4 py-3 border-t border-line text-xs text-ink-3">
            Only automatic backups are tidied up: the newest {keep} are kept. Manual backups and the copies made before
            a restore or an upgrade stay until you delete them.
          </p>
        )}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <Section
          title="Restore from file"
          description="Bring the system back to a backup you downloaded earlier."
        >
          <input
            ref={picker} type="file" accept=".db" className="hidden" tabIndex={-1}
            onChange={(e) => {
              const chosen = e.target.files?.[0]
              // Cleared so choosing the same file again is still noticed.
              e.target.value = ''
              if (chosen) chooseFile(chosen)
            }}
          />

          {file ? (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
              <FileUp size={16} className="text-ink-3 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="num text-sm text-ink truncate" title={file.name}>{file.name}</p>
                <p className="num text-xs text-ink-3">{formatSize(file.size)}</p>
              </div>
              <button type="button" className="btn-icon shrink-0" onClick={() => setFile(null)} disabled={uploading} aria-label="Remove the chosen file" title="Remove">
                <X size={15} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-4 py-6 text-ink-3 hover:text-ink-2 hover:bg-surface-2/60 transition-colors"
              onClick={() => picker.current?.click()}
            >
              <FileUp size={18} />
              <span className="text-sm font-medium text-ink-2">Choose a backup file</span>
              <span className="text-xs">A .db file from this system, up to 200 MB</span>
            </button>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button type="button" className="btn-danger" onClick={restoreUpload} disabled={!file || restoreDisabled}>
              {uploading ? <Spinner /> : <RotateCcw size={15} />} {uploading ? 'Uploading' : 'Restore from this file'}
            </button>
            {file && (
              <button type="button" className="btn-ghost" onClick={() => picker.current?.click()} disabled={uploading}>
                Choose another file
              </button>
            )}
          </div>
          <p className="help">
            Restoring replaces all current data. The current database is kept as a "Before a restore" backup, so a restore can be reversed.
          </p>
        </Section>

        <Section title="System" description="Facts about this installation.">
          {systemError ? (
            <ErrorState message={systemError} onRetry={loadSystem} />
          ) : system === null ? (
            <LoadingBlock label="Loading system information" />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                <Fact label="Version"><span className="num">{system.version}</span></Fact>
                <Fact label="Database size"><span className="num">{formatSize(system.database_size)}</span></Fact>
                <Fact label="Timezone">{system.timezone}</Fact>
                <Fact label="Email configured">{system.email_configured ? 'Yes' : 'No'}</Fact>
              </dl>

              <p className="eyebrow mt-6 mb-3">Records</p>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
                <Fact label="Clients"><span className="num">{formatNumber(system.counts.clients)}</span></Fact>
                <Fact label="Proposals"><span className="num">{formatNumber(system.counts.proposals)}</span></Fact>
                <Fact label="Invoices"><span className="num">{formatNumber(system.counts.invoices)}</span></Fact>
                <Fact label="Income entries"><span className="num">{formatNumber(system.counts.income)}</span></Fact>
                <Fact label="Expenses"><span className="num">{formatNumber(system.counts.expenses)}</span></Fact>
                <Fact label="People on payroll"><span className="num">{formatNumber(system.counts.payees)}</span></Fact>
              </dl>

              <p className="help mt-5">
                Automatic backups run daily at 02:00 ({system.timezone} time)
                {keep !== undefined ? `, keeping the last ${keep}.` : '.'}
              </p>
            </>
          )}
        </Section>
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 text-sm text-ink truncate">{children}</dd>
    </div>
  )
}
