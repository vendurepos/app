// The till frame's nav glyphs, drawn as Tally Woo's `apps/pos/components/app-rail.tsx` ports v2's tabler set (WCPOS
// monorepo `packages/components/src/icon/components/tabler/`, MIT): POS is Woo's `RegisterIcon`, Orders its
// `ReceiptIcon`, Settings its `GearIcon` (tabler `settings`); the cash register session is tabler `cash`.
import { Line, Path, Rect } from 'react-native-svg';
import { createSvgIcon } from '@tallyui/components';

export const PosIcon = createSvgIcon('PosIcon', () => (
  <><Rect x={3} y={9} width={18} height={12} rx={2} /><Line x1={7} y1={4} x2={17} y2={4} /><Line x1={12} y1={4} x2={12} y2={9} /><Line x1={7} y1={15} x2={17} y2={15} /></>
));

export const OrdersIcon = createSvgIcon('OrdersIcon', () => (
  <><Path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" /><Line x1={9} y1={7} x2={15} y2={7} /><Line x1={9} y1={11} x2={15} y2={11} /><Line x1={9} y1={15} x2={13} y2={15} /></>
));

// Customers: tabler's `users` outline (v2's Customers door).
export const CustomersIcon = createSvgIcon('CustomersIcon', () => (
  <>
    <Path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
    <Path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
    <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
    <Path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />
  </>
));

// Reports: tabler's `chart-bar` outline.
export const ReportsIcon = createSvgIcon('ReportsIcon', () => (
  <Path d="M3 12m0 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M10 8m0 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z M17 4m0 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z M4 21h16" />
));

export const CashIcon = createSvgIcon('CashIcon', () => (
  <>
    <Path d="M7 11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" />
    <Path d="M12 14a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />
    <Path d="M17 9V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
  </>
));

// Store health: tabler's `activity` outline (v2's Store health door).
export const HealthIcon = createSvgIcon('HealthIcon', () => <Path d="M3 12h4l3 8l4 -16l3 8h4" />);

// Notifications: tabler's `bell` outline (v2's Notifications door).
export const BellIcon = createSvgIcon('BellIcon', () => (
  <><Path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6" /><Path d="M9 17v1a3 3 0 0 0 6 0v-1" /></>
));

export const SettingsIcon = createSvgIcon('SettingsIcon', () => (
  <>
    <Path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065" />
    <Path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0" />
  </>
));

// Support: an outline speech bubble holding tabler `help`'s question mark.
export const SupportIcon = createSvgIcon('SupportIcon', () => (
  <>
    <Path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    <Path d="M12 12a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483" />
    <Path d="M12 15v.01" />
  </>
));
