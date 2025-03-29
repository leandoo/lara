#!/bin/bash

# Instalador do Lara Pro - Versão Robustecida

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para verificar erros
check_error() {
  if [ $? -ne 0 ]; then
    echo -e "${RED}Erro: $1${NC}"
    exit 1
  fi
}

echo -e "${YELLOW}Iniciando instalação do Lara Pro...${NC}"

# 1. Verificar e instalar Node.js
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}Node.js não encontrado. Instalando...${NC}"
  
  # Detectar sistema operacional
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew &> /dev/null; then
      echo -e "${YELLOW}Instalando Homebrew primeiro...${NC}"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    brew install node
  else
    echo -e "${RED}Sistema operacional não suportado. Instale Node.js manualmente.${NC}"
    exit 1
  fi
  
  check_error "Falha ao instalar Node.js"
fi

# 2. Verificar e instalar Git
if ! command -v git &> /dev/null; then
  echo -e "${YELLOW}Git não encontrado. Instalando...${NC}"
  
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    sudo apt-get install -y git
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    brew install git
  fi
  
  check_error "Falha ao instalar Git"
fi

# 3. Clonar repositório
INSTALL_DIR="$HOME/.lara-pro"
echo -e "${YELLOW}Baixando Lara Pro para $INSTALL_DIR...${NC}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}Diretório já existe. Atualizando...${NC}"
  cd "$INSTALL_DIR"
  git pull origin main
else
  git clone https://github.com/seu-usuario/lara-pro.git "$INSTALL_DIR"
fi

check_error "Falha ao baixar o repositório"

# 4. Instalar dependências
echo -e "${YELLOW}Instalando dependências...${NC}"
cd "$INSTALL_DIR"
npm install
check_error "Falha ao instalar dependências"

# 5. Criar link simbólico
echo -e "${YELLOW}Configurando comando global...${NC}"
sudo ln -sf "$INSTALL_DIR/bin/lara-pro" /usr/local/bin/lara-pro
check_error "Falha ao criar link simbólico"

# 6. Configurar permissões
chmod +x "$INSTALL_DIR/bin/lara-pro"

echo -e "${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Execute o Lara Pro com: ${YELLOW}lara-pro${NC}"
