#!/bin/bash

# Instalador Lara Pro para Termux - Versão 8.6.7 FIXED

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
LARA_JS_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"
BIN_PATH="$PREFIX/bin/lara"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Função de tratamento de erros melhorada
safe_run() {
  echo -e "${YELLOW}Executando: $1${NC}"
  eval "$1"
  if [ $? -ne 0 ]; then
    echo -e "${RED}Erro ao executar: $1${NC}"
    echo -e "${YELLOW}Tentando continuar em 5 segundos...${NC}"
    sleep 5
    return 1
  fi
  return 0
}

# 1. Corrigir possíveis problemas do dpkg
echo -e "${YELLOW}[1/8] Verificando sistema...${NC}"
safe_run "dpkg --configure -a"
safe_run "apt-get install -f -y"

# 2. Atualização básica com fallback
echo -e "${YELLOW}[2/8] Atualizando pacotes...${NC}"
safe_run "pkg update -y && pkg upgrade -y" || {
  echo -e "${YELLOW}Tentando método alternativo...${NC}"
  safe_run "apt update && apt upgrade -y"
}

# 3. Instalar dependências essenciais em etapas
echo -e "${YELLOW}[3/8] Instalando dependências básicas...${NC}"
for pkg in nodejs git curl wget; do
  safe_run "pkg install -y $pkg" || safe_run "apt install -y $pkg"
done

# 4. Dependências secundárias
echo -e "${YELLOW}[4/8] Instalando dependências adicionais...${NC}"
for pkg in python libxml2 libxslt openssl termux-exec; do
  safe_run "pkg install -y $pkg" || {
    echo -e "${YELLOW}Pacote $pkg opcional, continuando...${NC}"
    sleep 2
  }
done

# 5. Configuração Node.js
echo -e "${YELLOW}[5/8] Preparando ambiente Node.js...${NC}"
mkdir -p "$INSTALL_DIR" && cd "$INSTALL_DIR" || exit 1

# Package.json com fallback
if ! command -v npm &> /dev/null; then
  echo -e "${RED}NPM não encontrado! Instalando...${NC}"
  safe_run "pkg install -y nodejs npm"
fi

cat > package.json << 'EOF'
{
  "name": "lara-pro",
  "version": "1.0.0",
  "main": "lara.js",
  "scripts": {
    "start": "node lara.js"
  }
}
EOF

# 6. Instalação de módulos com retry
echo -e "${YELLOW}[6/8] Instalando módulos Node...${NC}"
for attempt in {1..3}; do
  npm install --save @google/generative-ai axios express glob crypto child_process && break
  echo -e "${YELLOW}Tentativa $attempt falhou, tentando novamente em 5 segundos...${NC}"
  sleep 5
done

# 7. Download do Lara com múltiplos fallbacks
echo -e "${YELLOW}[7/8] Baixando Lara Pro...${NC}"
download_success=false
for tool in curl wget node; do
  if command -v $tool &> /dev/null; then
    case $tool in
      curl)
        if curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js"; then
          download_success=true
          break
        fi
        ;;
      wget)
        if wget -q "$LARA_JS_URL" -O "$INSTALL_DIR/lara.js"; then
          download_success=true
          break
        fi
        ;;
      node)
        if node -e "require('https').get('$LARA_JS_URL', (r) => r.pipe(require('fs').createWriteStream('$INSTALL_DIR/lara.js')))"; then
          download_success=true
          break
        fi
        ;;
    esac
  fi
done

if [ "$download_success" = false ]; then
  echo -e "${RED}Falha ao baixar o Lara Pro${NC}"
  exit 1
fi

# 8. Configuração final
echo -e "${YELLOW}[8/8] Configurando ambiente...${NC}"
mkdir -p "$INSTALL_DIR"/{output,chunks,backups,memory,recovery}

cat > "$BIN_PATH" << 'EOF'
#!/bin/bash
cd "$HOME/.lara-pro" && node lara.js "$@"
EOF
chmod +x "$BIN_PATH"

echo -e "\n${GREEN}✔ Instalação concluída com sucesso!${NC}"
echo -e "\nIniciar com: ${CYAN}lara${NC}"
echo -e "Acesse a interface web: ${CYAN}http://localhost:5001${NC}"
