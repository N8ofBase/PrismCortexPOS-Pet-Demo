import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { StoreMark } from "../ui/StoreMark.tsx";
import { isHexColor, readableOn, ROLE_LABEL } from "@pet-pos/core";
import type { Me } from "@pet-pos/api";
import { AstroPage } from "../pages/AstroPage.tsx";
import { CustomersRoutes } from "../pages/customers/CustomersPage.tsx";
import { GroomingPage } from "../pages/grooming/GroomingPage.tsx";
import { InventoryRoutes } from "../pages/inventory/InventoryPage.tsx";
import { RegisterPage } from "../pages/register/RegisterPage.tsx";
import { ReportsRoutes } from "../pages/reports/ReportsPage.tsx";
import { SalesRoutes } from "../pages/SalesPage.tsx";
import { SettingsRoutes } from "../pages/Settings.tsx";
import { DemoBanner } from "./DemoBanner.tsx";
import { navFor } from "./nav.ts";

interface Props {
  me: Me;
  onSwitchRole: () => void;
  onResetDemo: () => Promise<void>;
}

const PAGES: Record<string, () => React.ReactNode> = {
  "/register": () => <RegisterPage />,
  "/grooming": () => <GroomingPage />,
  "/inventory": () => <InventoryRoutes />,
  "/customers": () => <CustomersRoutes />,
  "/sales": () => <SalesRoutes />,
  "/reports": () => <ReportsRoutes />,
  "/astro": () => <AstroPage />,
  "/settings": () => <SettingsRoutes />,
};

export function AdminShell({ me, onSwitchRole, onResetDemo }: Props) {
  const location = useLocation();
  const nav = navFor(me.staff.role);
  const brand = isHexColor(me.business.brandColor) ? me.business.brandColor! : "#0f6e5a";
  const brandText = readableOn(brand);
  const home = nav[0]?.path ?? "/settings";

  return (
    <div className="shell">
      <DemoBanner onReset={onResetDemo} />
      <nav className="sidebar" aria-label="Main">
        <div
          className="store-header store"
          data-testid="store-header"
          style={{ background: brand, color: brandText }}
        >
          <StoreMark name={me.business.name} logo={me.business.logo} color={brandText} />
          <span>
            <b>{me.business.name}</b>
            {me.location && <small>{me.location.name}</small>}
          </span>
        </div>
        {nav.map((n) => (
          <NavLink key={n.path} to={n.path}>
            {n.label}
          </NavLink>
        ))}
        <div className="who">
          <span>
            {me.staff.name} · {ROLE_LABEL[me.staff.role]}
          </span>
          <button type="button" onClick={onSwitchRole}>
            Switch role
          </button>
        </div>
      </nav>
      <main className="main">
        <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            {nav.map((n) => (
              <Route key={n.path} path={`${n.path}/*`} element={PAGES[n.path]?.()} />
            ))}
            <Route path="*" element={<Navigate to={home} replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
