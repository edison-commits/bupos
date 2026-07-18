import type { ComponentType } from "react";
import {
  ArrowLeftRight,
  Award,
  BadgePercent,
  Banknote,
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Gift,
  Globe,
  HelpCircle,
  LayoutDashboard,
  LayoutGrid,
  Package,
  PackageCheck,
  Receipt,
  ScrollText,
  Settings,
  Store,
  Tags,
  Timer,
  Truck,
  Undo2,
  Users,
} from "lucide-react";

/**
 * Admin navigation data — a LEAF module with no component imports, so both
 * AdminShell and CommandPalette can consume it. (Keeping it inside
 * admin-shell.tsx created a circular import with command-palette.tsx whose
 * module-scope NAV_GROUPS read hit the TDZ and crashed every admin page.)
 */

export type NavIcon = ComponentType<{ className?: string }>;
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Match only the exact path (for hub pages like /admin). */
  exact?: boolean;
}

export const NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [{ href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Sell",
    items: [
      { href: "/register", label: "Open Register", icon: Store },
      { href: "/admin/transactions", label: "Transactions", icon: Receipt },
      { href: "/admin/returns", label: "Returns", icon: Undo2 },
      { href: "/admin/shifts", label: "Shifts", icon: Clock },
      { href: "/admin/cash-drawer", label: "Cash Drawer", icon: Banknote },
      { href: "/admin/clock-in", label: "Clock In", icon: Timer },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/admin/products", label: "Products", icon: Package },
      { href: "/admin/inventory", label: "Inventory", icon: Boxes },
      { href: "/admin/purchase-orders", label: "Purchase Orders", icon: ClipboardList },
      { href: "/admin/receiving", label: "Receiving", icon: PackageCheck },
      { href: "/admin/suppliers", label: "Suppliers", icon: Truck },
      { href: "/admin/transfers", label: "Transfers", icon: ArrowLeftRight },
      { href: "/admin/stocktakes", label: "Stocktakes", icon: ClipboardCheck },
      { href: "/admin/labels", label: "Labels", icon: Tags },
    ],
  },
  {
    label: "Customers",
    items: [
      { href: "/admin/customers", label: "Customers", icon: Users },
      { href: "/admin/loyalty", label: "Loyalty", icon: Award },
      { href: "/admin/gift-cards", label: "Gift Cards", icon: Gift },
      { href: "/admin/layaways", label: "Layaways", icon: CalendarClock },
      { href: "/admin/promos", label: "Promos", icon: BadgePercent },
    ],
  },
  {
    label: "Channels",
    items: [{ href: "/admin/online-selling", label: "Online Selling", icon: Globe }],
  },
  {
    label: "Insights",
    items: [
      { href: "/admin/reports", label: "Reports", icon: BarChart3 },
      { href: "/admin/audit", label: "Audit Log", icon: ScrollText },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin", label: "More Tools", icon: LayoutGrid, exact: true },
      { href: "/admin/help", label: "Help", icon: HelpCircle },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];
