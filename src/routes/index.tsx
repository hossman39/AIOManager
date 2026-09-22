import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AccountsPage } from '@/pages/AccountsPage'
import { AccountDetailPage } from '@/pages/AccountDetailPage'
import { GroupsPage } from '@/pages/GroupsPage'
import { AccountImportPage } from '@/pages/AccountImportPage'
import { SavedAddonsPage } from '@/pages/SavedAddonsPage'
import { NotFoundPage } from '@/pages/NotFoundPage'

import { FAQPage } from '@/pages/FAQPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'

const ReplayPage = lazy(() => import('@/pages/ReplayPage').then(m => ({ default: m.ReplayPage })))
const ReplaySharePage = lazy(() => import('@/pages/ReplaySharePage').then(m => ({ default: m.ReplaySharePage })))
const ActivityPage = lazy(() => import('@/pages/ActivityPage').then(m => ({ default: m.ActivityPage })))
const MetricsPage = lazy(() => import('@/pages/MetricsPage').then(m => ({ default: m.MetricsPage })))
export function AppRoutes() {
  const location = useLocation()
  return (
    <Routes>
      <Route path="/" element={<AccountsPage />} />
      <Route path="/groups" element={<GroupsPage />} />
      <Route path="/accounts/import" element={<AccountImportPage />} />
      <Route path="/accounts/sync-settings" element={<Navigate to={`/settings${location.search}#account-sync`} replace />} />
      <Route path="/saved-addons" element={<SavedAddonsPage />} />
      <Route path="/managed" element={<Navigate to={`/${location.search}${location.hash}`} replace />} />

      <Route path="/activity" element={
        <ErrorBoundary>
          <Suspense fallback={<div className="p-8 text-center animate-pulse">Loading Activity...</div>}>
            <ActivityPage />
          </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/metrics" element={
        <ErrorBoundary>
          <Suspense fallback={<div className="p-8 text-center animate-pulse">Loading Metrics...</div>}>
            <MetricsPage />
          </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/replay" element={
        <ErrorBoundary>
          <Suspense fallback={<div className="p-8 text-center animate-pulse">Loading Replay...</div>}>
            <ReplayPage />
          </Suspense>
        </ErrorBoundary>
      } />
      <Route path="/replay/share/:token" element={
        <Suspense fallback={<div style={{ minHeight: '100vh', background: 'hsl(var(--background))' }} />}>
          <ReplaySharePage />
        </Suspense>
      } />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/faq" element={<FAQPage />} />
      <Route path="/account/:accountId" element={<AccountDetailPage />} />
      <Route path="/404" element={<NotFoundPage />} />
      <Route path="*" element={<Navigate to="/404" replace />} />
    </Routes>
  )
}

