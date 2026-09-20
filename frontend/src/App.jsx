import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { NotificationProvider } from './context/NotificationContext';
import ProtectedRoute from './components/ProtectedRoute';
import PermissionRoute from './components/PermissionRoute';
import AppLayout from './components/layout/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import ResetPassword from './pages/ResetPassword';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Servers from './pages/Servers';
import ServerDetail from './pages/ServerDetail';
import ServerResources from './pages/ServerResources';
import Certificates from './pages/Certificates';
import Posture from './pages/Posture';
import Administration from './pages/Administration';
import LegacyAdminRedirect from './components/admin/LegacyAdminRedirect';
import AccessRequests from './pages/AccessRequests';
import Sessions from './pages/Sessions';
import AuditLog from './pages/AuditLog';
import Notifications from './pages/Notifications';
import Terminal from './pages/Terminal';
import Terminals from './pages/Terminals';
import Connections from './pages/Connections';
import ConnectHub from './pages/ConnectHub';
import ActivityHub from './pages/ActivityHub';
import Device from './pages/Device';
import Profile from './pages/Profile';
import Register from './pages/Register';
import Legal from './pages/Legal';
import AuthCallback from './pages/AuthCallback';
import SsoLink from './pages/SsoLink';
import SsoLinkApprove from './pages/SsoLinkApprove';
import NotFound from './pages/NotFound';
import InstallCli from './pages/InstallCli';
import ApproveRequest from './pages/ApproveRequest';
import BulkImport from './pages/BulkImport';
import Keystore from './pages/Keystore';
import MyHosts from './pages/MyHosts';
import MfaSetup from './pages/MfaSetup';

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <NotificationProvider>
          <ErrorBoundary>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/password-reset/:token" element={<ResetPassword />} />
              <Route path="/approve/:token" element={<ApproveRequest />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/device" element={<Device />} />
              <Route path="/register" element={<Register />} />
              <Route path="/legal/:doc" element={<Legal />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/sso/link" element={<SsoLink />} />
              <Route path="/sso/link/approve" element={<SsoLinkApprove />} />
              <Route element={<ProtectedRoute />}>
                {/* Forced MFA enrollment — full screen, no app chrome */}
                <Route path="/mfa-setup" element={<MfaSetup />} />
                {/* Full-screen terminal — no app chrome */}
                <Route
                  path="/terminal"
                  element={
                    <div className="flex h-screen flex-col bg-background">
                      <Terminal />
                    </div>
                  }
                />
                <Route element={<AppLayout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/terminals" element={<Terminals />} />
                  <Route path="/connections" element={<Connections />} />
                  {/* Phone bottom-navigation hubs (lib/mobileNav.js); plain pages on desktop. */}
                  <Route path="/connect" element={<ConnectHub />} />
                  <Route path="/activity" element={<ActivityHub />} />
                  <Route path="/access-requests" element={<AccessRequests />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/install-cli" element={<InstallCli />} />
                  {/* Administration checks each section's permission itself:
                      no visible section → dashboard, hidden section → /admin. */}
                  <Route path="/admin" element={<Administration />} />
                  <Route path="/admin/:section" element={<Administration />} />
                  <Route path="/admin/:section/:id" element={<Administration />} />
                  {/* Old URLs → Administration (lib/adminSections.js legacyAdminPath) */}
                  <Route path="/settings" element={<LegacyAdminRedirect />} />
                  <Route path="/users" element={<LegacyAdminRedirect />} />
                  <Route path="/users/:id" element={<LegacyAdminRedirect />} />
                  <Route path="/roles" element={<LegacyAdminRedirect />} />
                  <Route path="/roles/:id" element={<LegacyAdminRedirect />} />
                  <Route path="/groups" element={<LegacyAdminRedirect />} />
                  <Route path="/groups/:id" element={<LegacyAdminRedirect />} />
                  <Route path="/policies" element={<LegacyAdminRedirect />} />
                  {/* Permission-gated pages — see ROUTE_ACCESS in lib/commands.js */}
                  <Route element={<PermissionRoute />}>
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/customers/:id" element={<CustomerDetail />} />
                    <Route path="/servers" element={<Servers />} />
                    <Route path="/servers/:id" element={<ServerDetail />} />
                    <Route path="/servers/:id/resources" element={<ServerResources />} />
                    <Route path="/sessions" element={<Sessions />} />
                    <Route path="/keystore" element={<Keystore />} />
                    <Route path="/my-hosts" element={<MyHosts />} />
                    <Route path="/bulk-import" element={<BulkImport />} />
                    <Route path="/certificates" element={<Certificates />} />
                    <Route path="/posture" element={<Posture />} />
                    <Route path="/audit-log" element={<AuditLog />} />
                  </Route>
                </Route>
              </Route>
              {/* 404 catch-all */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </NotificationProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
