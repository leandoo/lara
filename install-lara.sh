#!/bin/bash

# Instalador Lara Pro com comando 'lara vem'
# Cria toda estrutura e configura o comando simplificado

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
LARA_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Criar estrutura de diretórios
echo -e "${YELLOW}Configurando Lara Pro...${NC}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Baixar arquivo principal
echo -e "${YELLOW}Obtendo código principal...${NC}"
curl -sSL "$LARA_URL" -o "lara.js" || {
    echo -e "${RED}Erro ao baixar o arquivo principal${NC}"
    exit 1
}

# Criar arquivo de comando simplificado
echo -e "${YELLOW}Criando comando 'lara vem'...${NC}"
sudo tee /usr/local/bin/lara > /dev/null << 'EOF'
#!/bin/bash
if [[ "$1" == "vem" ]]; then
    node "$HOME/.lara-pro/lara.js"
else
    echo "Comando inválido. Use 'lara vem' para iniciar."
fi
EOF

# Dar permissões
sudo chmod +x /usr/local/bin/lara

# Instalar Node.js se necessário
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Instalando Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs npm || {
        echo -e "${RED}Falha ao instalar Node.js${NC}"
        exit 1
    }
fi

# Instalar dependências
echo -e "${YELLOW}Instalando dependências...${NC}"
npm install @google/generative-ai axios express

echo -e "${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Agora você pode iniciar o Lara com: ${YELLOW}lara vem${NC}"
