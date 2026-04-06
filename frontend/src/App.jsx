import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { NotificationProvider } from './context/NotificationContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
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
import Terminal from './pages/Terminal';
import NotFound from './pages/NotFound';

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <NotificationProvider>
          <ErrorBoundary>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<ProtectedRoute />}>
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
                  <Route path="/users" element={<Users />} />
                  <Route path="/groups" element={<Groups />} />
                  <Route path="/groups/:id" element={<GroupDetail />} />
                  <Route path="/customers" element={<Customers />} />
                  <Route path="/customers/:id" element={<CustomerDetail />} />
                  <Route path="/servers" element={<Servers />} />
                  <Route path="/servers/:id" element={<ServerDetail />} />
                  <Route path="/certificates" element={<Certificates />} />
                  <Route path="/policies" element={<Policies />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/access-requests" element={<AccessRequests />} />
                  <Route path="/sessions" element={<Sessions />} />
                  <Route path="/audit-log" element={<AuditLog />} />
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
