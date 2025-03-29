#!/bin/bash

# Instalação do Lara Pro - Assistente Inteligente

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Instalando Lara Pro...${NC}"

# Verifica se o Node.js está instalado
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js não encontrado!${NC}"
    echo -e "${YELLOW}Instalando Node.js...${NC}"
    
    # Tenta instalar o Node.js (suporta diferentes sistemas)
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install node
    else
        echo -e "${RED}Sistema operacional não suportado. Por favor instale Node.js manualmente.${NC}"
        exit 1
    fi
fi

# Clona o repositório
echo -e "${YELLOW}Baixando Lara Pro...${NC}"
git clone https://github.com/seu-usuario/lara-pro.git ~/.lara-pro

# Instala dependências
echo -e "${YELLOW}Instalando dependências...${NC}"
cd ~/.lara-pro
npm install

# Cria link simbólico para usar globalmente
echo -e "${YELLOW}Configurando comando global...${NC}"
sudo ln -s ~/.lara-pro/bin/lara-pro /usr/local/bin/lara-pro

# Configuração inicial
echo -e "${YELLOW}Configurando ambiente...${NC}"
mkdir -p ~/.lara-pro/config
cp config/default.json ~/.lara-pro/config/

echo -e "${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Execute com: ${YELLOW}lara-pro${NC}"
