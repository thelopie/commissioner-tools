import { useEffect } from 'react';
import {
  AppBar,
  Box,
  BottomNavigation,
  BottomNavigationAction,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import HomeIcon from '@mui/icons-material/HomeRounded';
import ScoreboardIcon from '@mui/icons-material/ScoreboardRounded';
import LeaderboardIcon from '@mui/icons-material/LeaderboardRounded';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import CloudSyncIcon from '@mui/icons-material/CloudSyncRounded';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import GroupsIcon from '@mui/icons-material/GroupsRounded';
import SwapHorizIcon from '@mui/icons-material/SwapHorizRounded';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumberedRounded';
import SportsBaseballIcon from '@mui/icons-material/SportsBaseballRounded';
import CampaignIcon from '@mui/icons-material/CampaignRounded';
import ArticleIcon from '@mui/icons-material/ArticleRounded';
import PaymentsIcon from '@mui/icons-material/PaymentsRounded';
import ChecklistIcon from '@mui/icons-material/ChecklistRounded';
import SettingsIcon from '@mui/icons-material/SettingsRounded';
import LightModeIcon from '@mui/icons-material/LightModeRounded';
import DarkModeIcon from '@mui/icons-material/DarkModeRounded';
import ContrastIcon from '@mui/icons-material/ContrastRounded';
import LogoutIcon from '@mui/icons-material/LogoutRounded';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useColorScheme } from '../theme/ColorSchemeProvider.js';
import { RAIL_WIDTH } from '../theme/tokens.js';
import { Monogram } from './primitives.js';

/**
 * Application shell.
 *
 * Navigation adapts rather than shrinking: a navigation rail from 900px up, a
 * bottom navigation bar below it. The original design crammed four text links
 * into the top bar, which on a phone left them tiny, unlabelled by position, and
 * a long reach from the thumb. Bottom navigation is where a phone user's hand
 * already is, and the rail gives desktop users persistent labelled targets.
 */

export interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
  /** Commissioner-only entries are hidden for others; the API refuses them too. */
  commissionerOnly?: boolean;
}

/**
 * Primary navigation: what a league MEMBER needs.
 *
 * Five items, the M3 ceiling for bottom navigation. Administrative screens live in
 * the account menu instead — a manager has no use for OAuth token rotation counts,
 * and the first build put them front and centre.
 */
const NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: '/', icon: <HomeIcon /> },
  { label: 'My team', to: '/my-team', icon: <GroupsIcon /> },
  { label: 'Matchups', to: '/matchups', icon: <ScoreboardIcon /> },
  { label: 'Standings', to: '/standings', icon: <LeaderboardIcon /> },
  { label: 'Challenges', to: '/challenges', icon: <EmojiEventsIcon /> },
];

/**
 * League screens that every member can reach, but which do not earn a nav slot.
 *
 * Transactions matter, but not as much as the five above — and a sixth bottom-bar
 * item would shrink all of them below a comfortable tap target.
 */
const MEMBER_ITEMS: Array<{ label: string; to: string; icon: React.ReactNode }> = [
  { label: 'Announcements', to: '/announcements', icon: <CampaignIcon /> },
  { label: 'Recaps', to: '/recaps', icon: <ArticleIcon /> },
  { label: 'Dues and prizes', to: '/money', icon: <PaymentsIcon /> },
  { label: 'Draft order', to: '/draft', icon: <FormatListNumberedIcon /> },
  { label: 'Transactions', to: '/transactions', icon: <SwapHorizIcon /> },
];

/** Administrative screens, reached from the account menu. */
const COMMISSIONER_ITEMS: Array<{ label: string; to: string; icon: React.ReactNode }> = [
  { label: 'Commissioner tools', to: '/commissioner', icon: <SettingsIcon /> },
  { label: 'LLWS draft setup', to: '/commissioner/llws', icon: <SportsBaseballIcon /> },
  { label: 'My task list', to: '/commissioner/tasks', icon: <ChecklistIcon /> },
  { label: 'Yahoo status', to: '/yahoo-capabilities', icon: <CloudSyncIcon /> },
  { label: 'Audit history', to: '/audit', icon: <HistoryIcon /> },
];

export interface AppShellProps {
  children: React.ReactNode;
  authenticated: boolean;
  isCommissioner: boolean;
  displayName?: string | undefined;
  roleLabel?: string | undefined;
  yahooMode: 'mock' | 'live' | undefined;
  onSignOut: () => void;
  signOutPending: boolean;
}

/** M3 active-indicator geometry, shared by every bottom-navigation item. */
const navPillSx = {
  width: 56,
  height: 30,
  borderRadius: 999,
  display: 'grid',
  placeItems: 'center',
  transition: 'background-color 150ms cubic-bezier(0.2, 0, 0, 1)',
  '& svg': { fontSize: 22 },
} as const;

export function AppShell({
  children,
  authenticated,
  isCommissioner,
  displayName,
  roleLabel,
  yahooMode,
  onSignOut,
  signOutPending,
}: AppShellProps): JSX.Element {
  const theme = useTheme();
  const showRail = useMediaQuery(theme.breakpoints.up('md'));
  const location = useLocation();

  // Every primary item is member-facing, so nothing is filtered here.
  const items = NAV_ITEMS;

  /**
   * Move focus to the page title on navigation.
   *
   * Without this a client-side route change is invisible to a screen reader and
   * leaves keyboard focus wherever it was — usually the nav item just clicked, so
   * the next Tab walks the nav again instead of entering the new page.
   */
  useEffect(() => {
    const heading = document.getElementById('page-title');
    heading?.focus();
  }, [location.pathname]);

  const activeIndex = items.findIndex(
    (item) => item.to === (location.pathname === '' ? '/' : location.pathname),
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      {/* Keyboard users should be able to skip the nav on every page. */}
      <Box
        component="a"
        href="#main"
        sx={{
          position: 'absolute',
          left: 12,
          top: -60,
          zIndex: theme.zIndex.tooltip + 1,
          px: 2,
          py: 1.25,
          borderRadius: 2,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          typography: 'button',
          textDecoration: 'none',
          transition: 'top 150ms',
          '&:focus': { top: 12 },
        }}
      >
        Skip to content
      </Box>

      {authenticated && showRail && <NavigationRail items={items} pathname={location.pathname} />}

      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            bgcolor: 'background.default',
            color: 'text.primary',
            borderBottom: 1,
            borderColor: 'divider',
            // Keeps the bar readable when content scrolls beneath it.
            backdropFilter: 'saturate(180%) blur(8px)',
          }}
        >
          <Toolbar sx={{ gap: 1.5, minHeight: { xs: 60, md: 68 } }}>
            {(!authenticated || !showRail) && <Wordmark />}

            <Box sx={{ flexGrow: 1 }} />

            {yahooMode === 'mock' && (
              <Tooltip title="Reading synthetic fixtures from the local mock server. No real Yahoo data is involved.">
                <Chip size="small" color="warning" label="Mock data" />
              </Tooltip>
            )}

            <ThemeToggle />

            {authenticated && (
              <AccountMenu
                displayName={displayName ?? 'Manager'}
                roleLabel={roleLabel}
                isCommissioner={isCommissioner}
                onSignOut={onSignOut}
                signOutPending={signOutPending}
              />
            )}
          </Toolbar>
        </AppBar>

        <Box
          component="main"
          id="main"
          sx={{
            flexGrow: 1,
            px: { xs: 2, sm: 3, lg: 4 },
            py: { xs: 2.5, sm: 3.5 },
            // Room for the bottom navigation on small screens.
            pb: { xs: authenticated ? 12 : 4, md: 5 },
            maxWidth: 1200,
            width: '100%',
            mx: 'auto',
          }}
        >
          {children}
        </Box>

        <Box
          component="footer"
          sx={{
            px: 3,
            py: 2.5,
            mb: { xs: authenticated ? 9 : 0, md: 0 },
            borderTop: 1,
            borderColor: 'divider',
          }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', maxWidth: '80ch' }}
          >
            A private, noncommercial league tool. Not affiliated with or endorsed by Yahoo. Yahoo
            data is read live under read-only access and is not stored permanently.
          </Typography>
        </Box>
      </Box>

      {authenticated && !showRail && (
        <BottomNavigation
          /**
           * `false`, not `0`, when the route is not in the bar.
           *
           * Falling back to 0 lit up Home while the user was on Transactions or a
           * commissioner screen — an indicator pointing at the wrong page is worse
           * than none.
           */
          value={activeIndex === -1 ? false : activeIndex}
          showLabels
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: theme.zIndex.appBar,
            height: 76,
            bgcolor: 'background.surfaceContainer',
            borderTop: 1,
            borderColor: 'divider',
            // Avoid the home indicator on modern phones.
            pb: 'env(safe-area-inset-bottom)',
          }}
        >
          {items.map((item) => (
            <BottomNavigationAction
              key={item.to}
              component={RouterLink}
              to={item.to}
              label={item.label}
              icon={
                // The pill is a wrapper, not padding on the svg: padding on an
                // <svg> grows the box without moving the glyph, which hid the icon.
                <Box className="nav-pill" sx={navPillSx}>
                  {item.icon}
                </Box>
              }
              sx={{
                minWidth: 0,
                pt: 1.25,
                // MUI's default 12px side padding leaves ~54px of label room across
                // five items on a 390px phone, which wrapped "My team" onto two
                // lines and clipped "Challenges". Reclaim the padding and forbid
                // wrapping instead of shortening the labels.
                px: 0.25,
                color: 'text.secondary',
                '& .MuiBottomNavigationAction-label': {
                  whiteSpace: 'nowrap',
                  fontSize: '0.6875rem',
                },
                '&.Mui-selected': { color: 'primary.main' },
                '&.Mui-selected .MuiBottomNavigationAction-label': {
                  fontWeight: 700,
                  fontSize: '0.6875rem',
                },
                '&.Mui-selected .nav-pill': {
                  bgcolor: 'primary.light',
                  color: 'primary.dark',
                },
              }}
            />
          ))}
        </BottomNavigation>
      )}
    </Box>
  );
}

/** Persistent labelled navigation for tablet and desktop. */
function NavigationRail({ items, pathname }: { items: NavItem[]; pathname: string }): JSX.Element {
  return (
    <Box
      component="nav"
      aria-label="Main"
      sx={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        py: 2,
        bgcolor: 'background.surfaceContainerLow',
        borderRight: 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ mb: 2 }}>
        <Crest />
      </Box>

      {items.map((item) => {
        const active = item.to === (pathname === '' ? '/' : pathname);
        return (
          <Box
            key={item.to}
            component={RouterLink}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            sx={{
              width: 68,
              textDecoration: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.5,
              py: 0.5,
              color: active ? 'primary.main' : 'text.secondary',
              '&:hover .rail-indicator': {
                bgcolor: (theme) =>
                  active ? theme.palette.primary.light : alpha(theme.palette.text.primary, 0.08),
              },
            }}
          >
            <Box
              className="rail-indicator"
              sx={{
                width: 56,
                height: 32,
                borderRadius: 999,
                display: 'grid',
                placeItems: 'center',
                bgcolor: active ? 'primary.light' : 'transparent',
                color: active ? 'primary.dark' : 'inherit',
                transition: (theme) =>
                  `background-color ${theme.transitions.duration.short}ms ${theme.transitions.easing.easeInOut}`,
                '& svg': { fontSize: 22 },
              }}
            >
              {item.icon}
            </Box>
            <Typography
              sx={{
                fontSize: '0.6875rem',
                fontWeight: active ? 700 : 600,
                letterSpacing: '0.03em',
                textAlign: 'center',
              }}
            >
              {item.label}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function Crest(): JSX.Element {
  return (
    <Tooltip title="Dinkel Portal">
      <Box
        component={RouterLink}
        to="/"
        aria-label="Dinkel Portal home"
        sx={{
          width: 44,
          height: 44,
          borderRadius: 3,
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          textDecoration: 'none',
          fontWeight: 800,
          fontSize: '1.1rem',
        }}
      >
        D
      </Box>
    </Tooltip>
  );
}

function Wordmark(): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="center"
      component={RouterLink}
      to="/"
      sx={{
        textDecoration: 'none',
        color: 'inherit',
        minWidth: 0,
        // A 44px hit area around a 32px crest. This is the home affordance on
        // mobile, so it should be comfortable rather than merely AA-compliant.
        py: 0.75,
        pr: 0.5,
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 2,
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          fontWeight: 800,
          flexShrink: 0,
        }}
      >
        D
      </Box>
      <Typography
        variant="h3"
        noWrap
        sx={{
          fontWeight: 700,
          // Hidden on the narrowest screens, where the top bar also carries the
          // mode chip, theme toggle, and avatar. A truncated "Dinkel…" is worse
          // than the crest alone.
          display: { xs: 'none', sm: 'block' },
        }}
      >
        Dinkel Portal
      </Typography>
    </Stack>
  );
}

function ThemeToggle(): JSX.Element {
  const { preference, cycle } = useColorScheme();

  const { icon, label } =
    preference === 'system'
      ? { icon: <ContrastIcon />, label: 'Theme: following your device' }
      : preference === 'light'
        ? { icon: <LightModeIcon />, label: 'Theme: light' }
        : { icon: <DarkModeIcon />, label: 'Theme: dark' };

  return (
    <Tooltip title={`${label} — click to change`}>
      <IconButton onClick={cycle} aria-label={label}>
        {icon}
      </IconButton>
    </Tooltip>
  );
}

function AccountMenu({
  displayName,
  roleLabel,
  isCommissioner,
  onSignOut,
  signOutPending,
}: {
  displayName: string;
  roleLabel: string | undefined;
  isCommissioner: boolean;
  onSignOut: () => void;
  signOutPending: boolean;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title="Account">
        <IconButton
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-label={`Account: ${displayName}`}
          sx={{ p: 0.5 }}
        >
          <Monogram name={displayName} size={36} />
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 240, mt: 1, borderRadius: 3 } } }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {displayName}
          </Typography>
          {roleLabel && (
            <Typography variant="caption" color="text.secondary">
              {roleLabel}
            </Typography>
          )}
        </Box>
        <Divider />

        {MEMBER_ITEMS.map((item) => (
          <MenuItem
            key={item.to}
            component={RouterLink}
            to={item.to}
            onClick={() => setAnchor(null)}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText>{item.label}</ListItemText>
          </MenuItem>
        ))}

        <Divider />

        {isCommissioner &&
          COMMISSIONER_ITEMS.map((item) => (
            <MenuItem
              key={item.to}
              component={RouterLink}
              to={item.to}
              onClick={() => setAnchor(null)}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText>{item.label}</ListItemText>
            </MenuItem>
          ))}

        {isCommissioner && <Divider />}

        <MenuItem
          onClick={() => {
            setAnchor(null);
            onSignOut();
          }}
          disabled={signOutPending}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{signOutPending ? 'Signing out…' : 'Sign out'}</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
