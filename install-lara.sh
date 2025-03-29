#!/bin/bash

# Instalador Offline Lara Pro
# Cria toda estrutura necessária automaticamente

# Configurações
INSTALL_DIR="$HOME/.lara-pro"
BIN_PATH="/usr/local/bin/lara-pro"
LARA_URL="https://raw.githubusercontent.com/leandoo/lara/main/lara.js"  # Substitua pelo seu URL

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Função para criar estrutura
create_structure() {
    echo -e "${YELLOW}Criando estrutura de diretórios...${NC}"
    mkdir -p "$INSTALL_DIR"/{bin,lib,config}
    
    # Criar arquivos essenciais
    cat > "$INSTALL_DIR/bin/lara-pro" << 'EOF'
#!/bin/bash
NODE_PATH="$HOME/.lara-pro/lib" node "$HOME/.lara-pro/lib/lara.js" "$@"
EOF

    cat > "$INSTALL_DIR/config/default.json" << 'EOF'
{
    "PORT": 5000,
    "WEB_PORT": 5001,
    "buffer": {
        "maxTokens": 8192,
        "maxChunkSize": 15000
    }
}
EOF

    # Baixar apenas o arquivo principal
    echo -e "${YELLOW}Baixando arquivo principal...${NC}"
    curl -sSL "$LARA_URL" -o "$INSTALL_DIR/lib/lara.js" || {
        echo -e "${RED}Falha ao baixar o arquivo principal${NC}"
        exit 1
    }

    # Configurar permissões
    chmod +x "$INSTALL_DIR/bin/lara-pro"
}

# Verificar e instalar Node.js
install_node() {
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}Instalando Node.js...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs npm || {
            echo -e "${RED}Falha ao instalar Node.js${NC}"
            exit 1
        }
    fi
}

# Instalar dependências
install_deps() {
    echo -e "${YELLOW}Instalando dependências...${NC}"
    local deps=("@google/generative-ai" "axios" "express")
    for dep in "${deps[@]}"; do
        npm install --prefix "$INSTALL_DIR" "$dep" || {
            echo -e "${RED}Falha ao instalar $dep${NC}"
            exit 1
        }
    done
}

# Criar link simbólico
create_link() {
    echo -e "${YELLOW}Criando link global...${NC}"
    sudo ln -sf "$INSTALL_DIR/bin/lara-pro" "$BIN_PATH" || {
        echo -e "${YELLOW}Não foi possível criar link global${NC}"
        echo -e "Você pode executar diretamente com: ${GREEN}$INSTALL_DIR/bin/lara-pro${NC}"
    }
}

# Main
echo -e "${GREEN}Iniciando instalação offline do Lara Pro...${NC}"
install_node
create_structure
install_deps
create_link

echo -e "${GREEN}Instalação concluída com sucesso!${NC}"
echo -e "Execute com: ${YELLOW}lara-pro${NC}"
