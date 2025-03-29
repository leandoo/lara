#!/bin/bash

# Instalador Lara Pro para Termux - Versão 8.6.5
# Correção para falha na inicialização do projeto Node.js
# URL RAW: https://raw.githubusercontent.com/leandoo/lara/main/install-lara.sh

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

# Função para verificar erros com fallback
safe_check() {
  if [ $? -ne 0 ]; then
    echo -e "${YELLOW}Aviso: $1${NC}"
    return 1
  fi
  return 0
}

# 1. Configurar ambiente Termux
echo -e "${YELLOW}[1/7] Configurando ambiente Termux...${NC}"
termux-change-repo <<< "1
1
Y
" > /dev/null 2>&1
pkg update -y && pkg upgrade -y
safe_check "Atualização de pacotes teve avisos"

# 2. Instalar dependências básicas
echo -e "${YELLOW}[2/7] Instalando dependências básicas...${NC}"
pkg install -y nodejs git curl wget python libxml2 libxslt openssl termux-exec
safe_check "Algumas dependências tiveram avisos"

# 3. Configurar ambiente Node.js (approach alternativo)
echo -e "${YELLOW}[3/7] Preparando ambiente Node.js...${NC}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Criar package.json manualmente se npm init falhar
cat > package.json << 'EOF'
{
  "name": "lara-pro",
  "version": "1.0.0",
  "description": "Lara Pro Environment",
  "main": "lara.js",
  "scripts": {
    "start": "node lara.js"
  },
  "dependencies": {}
}
EOF

# 4. Instalar dependências com verificação reforçada
echo -e "${YELLOW}[4/7] Instalando dependências Node.js...${NC}"
for pkg in @google/generative-ai axios express glob crypto child_process; do
  echo -e "${CYAN}Instalando $pkg...${NC}"
  npm install --save "$pkg" > /dev/null 2>&1
  safe_check "Instalação de $pkg teve avisos"
done

# 5. Baixar Lara Pro com múltiplas fontes
echo -e "${YELLOW}[5/7] Baixando Lara Pro...${NC}"
curl -sSL "$LARA_JS_URL" -o "$INSTALL_DIR/lara.js" || \
wget -q "$LARA_JS_URL" -O "$INSTALL_DIR/lara.js"
safe_check "Download pode ter tido avisos"

# 6. Criar estrutura de diretórios
echo -e "${YELLOW}[6/7] Criando estrutura...${NC}"
mkdir -p "$INSTALL_DIR"/{output,chunks,backups,memory,recovery}

# Criar reacoes.json manualmente
cat > "$INSTALL_DIR/reacoes.json" << 'EOF'
{
    "feliz": {
        "tipo": "ascii",
        "conteudo": " (＾▽＾) ",
        "tags": ["feliz", "alegre", "content"]
    },
    "triste": {
        "tipo": "ascii",
        "conteudo": " (╥_╥) ",
        "tags": ["triste", "depre"]
    },
    "safado": {
        "tipo": "ascii",
        "conteudo": " ( ͡° ͜ʖ ͡°) ",
        "tags": ["safado", "nsfw", "sexo"]
    }
}
EOF

# 7. Configurar comando global
echo -e "${YELLOW}[7/7] Criando comando global...${NC}"
cat > "$BIN_PATH" << 'EOF'
#!/bin/bash
cd "$HOME/.lara-pro"
node lara.js "$@"
EOF

chmod +x "$BIN_PATH"
safe_check "Criação do comando teve avisos"

# Configurar PATH
grep -q "$PREFIX/bin" "$HOME/.bashrc" || echo 'export PATH="$PREFIX/bin:$PATH"' >> "$HOME/.bashrc"

# Verificação final
echo -e "\n${GREEN}✔ Instalação concluída!${NC}"
echo -e "\n${CYAN}Como usar:${NC}"
echo -e "  lara vem       # Iniciar"
echo -e "  lara ajuda     # Ajuda"

echo -e "\n${YELLOW}Verificando dependências...${NC}"
cd "$INSTALL_DIR"
if node -e "require('@google/generative-ai'); console.log('✓ Tudo OK')" 2>/dev/null; then
  echo -e "${GREEN}✓ Lara está pronta para uso!${NC}"
else
  echo -e "${YELLOW}⚠ Problema detectado. Execute:${NC}"
  echo -e "cd $INSTALL_DIR && npm install"
  echo -e "E depois tente novamente: lara vem"
fi
