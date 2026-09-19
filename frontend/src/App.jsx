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
import Users from './pages/Users';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Servers from './pages/Servers';
import ServerDetail from './pages/ServerDetail';
import Certificates from './pages/Certificates';
import Policies from './pages/Policies';
import Settings from './pages/Settings';
import AccessRequests from './pages/AccessRequests';
import Sessions from './pages/Sessions';
import AuditLog from './pages/AuditLog';
import Notifications from './pages/Notifications';
import Terminal from './pages/Terminal';
import Terminals from './pages/Terminals';
import Connections from './pages/Connections';
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
import Roles from './pages/Roles';
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
                  <Route path="/access-requests" element={<AccessRequests />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/install-cli" element={<InstallCli />} />
                  {/* Permission-gated pages — see ROUTE_ACCESS in lib/commands.js */}
                  <Route element={<PermissionRoute />}>
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/customers/:id" element={<CustomerDetail />} />
                    <Route path="/servers" element={<Servers />} />
                    <Route path="/servers/:id" element={<ServerDetail />} />
                    <Route path="/sessions" element={<Sessions />} />
                    <Route path="/keystore" element={<Keystore />} />
                    <Route path="/my-hosts" element={<MyHosts />} />
                    <Route path="/users" element={<Users />} />
                    <Route path="/roles" element={<Roles />} />
                    <Route path="/roles/:id" element={<Roles />} />
                    <Route path="/groups" element={<Groups />} />
                    <Route path="/groups/:id" element={<GroupDetail />} />
                    <Route path="/bulk-import" element={<BulkImport />} />
                    <Route path="/certificates" element={<Certificates />} />
                    <Route path="/policies" element={<Policies />} />
                    <Route path="/settings" element={<Settings />} />
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
