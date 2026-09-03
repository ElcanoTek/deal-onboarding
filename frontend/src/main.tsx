// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import App from './App'
import { UpdateBanner } from './components/UpdateBanner'
import { installNumberInputWheelGuard } from './lib/numberInputWheelGuard'
import { installChunkReloadGuard } from './lib/appUpdate'

// Scrolling must never mutate a focused number field (the DEAL07254 $0.10 →
// $0.08 floor incident) — see numberInputWheelGuard.ts.
installNumberInputWheelGuard()

// A deploy replaces the content-hashed chunks; a tab held open across one
// 404s on its next lazy import. Auto-reload once (ChunkErrorBoundary stays
// as the manual backstop) — see appUpdate.ts.
installChunkReloadGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <UpdateBanner />
  </StrictMode>,
)
