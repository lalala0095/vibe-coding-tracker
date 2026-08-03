import { GoogleOAuthProvider } from '@react-oauth/google';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ModelsPage from './pages/ModelsPage';
import TasksPage from './pages/TasksPage';
import ClientsProjectsPage from './pages/ClientsProjectsPage';
import TrackersPage from './pages/TrackersPage';
import InvoicesPage from './pages/InvoicesPage';
import InvoiceSettingsPage from './pages/InvoiceSettingsPage';
import InvoicePrintPage from './components/InvoicePrintView';
import ProtectedRoute from './components/ProtectedRoute';

function AppRoutes() {
  const { user } = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/models"
          element={
            <ProtectedRoute>
              <ModelsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tasks"
          element={
            <ProtectedRoute>
              <TasksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/manage"
          element={
            <ProtectedRoute>
              <ClientsProjectsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trackers"
          element={
            <ProtectedRoute>
              <TrackersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoices"
          element={
            <ProtectedRoute>
              <InvoicesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoices/settings"
          element={
            <ProtectedRoute>
              <InvoiceSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoices/:id/print"
          element={
            <ProtectedRoute>
              <InvoicePrintPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
