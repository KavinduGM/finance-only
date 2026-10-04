import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'

export default function Layout() {
  const [navOpen, setNavOpen] = useState(false)
  const { pathname } = useLocation()

  // On small screens the menu is a drawer; close it after navigating.
  useEffect(() => setNavOpen(false), [pathname])

  return (
    <div className="flex h-screen overflow-hidden app-backdrop">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
