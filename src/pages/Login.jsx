import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("admin@easycred");
  const [senha, setSenha] = useState("");

  async function entrar(e) {
    e.preventDefault();

    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: senha }),
      });
      if (!response.ok) throw new Error("Invalid credentials");

      const tokens = await response.json();
      localStorage.setItem("accessToken", tokens.accessToken);
      localStorage.setItem("refreshToken", tokens.refreshToken);
      navigate("/dashboard");
    } catch {
      alert("Email ou senha incorretos");
    }
  }

  return (
    <div style={pageStyle}>
      <form onSubmit={entrar} style={cardStyle}>
        <h2 style={{ color: "#00b36b", textAlign: "center" }}>
          Easy Cred
        </h2>

        <label>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />

        <label>Senha</label>
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          style={inputStyle}
        />

        <button type="submit" style={buttonStyle}>
          Entrar
        </button>

      </form>
    </div>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: "#f4f6f8",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle = {
  width: 320,
  background: "#222",
  color: "#fff",
  padding: 25,
  borderRadius: 18,
  boxShadow: "0 4px 15px rgba(0,0,0,.25)",
};

const inputStyle = {
  width: "100%",
  padding: 12,
  marginTop: 5,
  marginBottom: 12,
  borderRadius: 8,
  border: "none",
  boxSizing: "border-box",
};

const buttonStyle = {
  width: "100%",
  padding: 12,
  background: "#00b36b",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: "bold",
};

export default Login;
