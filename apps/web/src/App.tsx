import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";
import Login from "./routes/Login";
import Devices from "./routes/Devices";
import VersionNueva from "./components/VersionNueva";
import { useAuthStore } from "./store/auth.store";

function RequireAuth({ children }: { children: JSX.Element }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  if (!accessToken) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <VersionNueva />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/devices"
          element={
            <RequireAuth>
              <Devices />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/devices" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
