#!/bin/bash

# Instalador Automático Lara Pro - Versão Tudo-em-Um
# URL: https://raw.githubusercontent.com/leandoo/lara/main/install.sh

# Cores para melhor visualização
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para verificar e instalar dependências
install_dependencies() {
    echo -e "${YELLOW}Verificando dependências...${NC}"
    
    # Verifica Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}Instalando Node.js...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs || {
            echo -e "${RED}Falha ao instalar Node.js${NC}"
            exit 1
        }
    fi

    # Verifica npm
    if ! command -v npm &> /dev/null; then
        echo -e "${YELLOW}Instalando npm...${NC}"
        sudo apt-get install -y npm || {
            echo -e "${RED}Falha ao instalar npm${NC}"
            exit 1
        }
    fi

    # Verifica git
    if ! command -v git &> /dev/null; then
        echo -e "${YELLOW}Instalando git...${NC}"
        sudo apt-get install -y git || {
            echo -e "${RED}Falha ao instalar git${NC}"
            exit 1
        }
    fi
}

# Função principal
main() {
    # Cria um arquivo temporário com permissão de execução
    TEMP_SCRIPT=$(mktemp)
    trap "rm -f $TEMP_SCRIPT" EXIT
    
    echo -e "${GREEN}Baixando e preparando instalador...${NC}"
    
    # Baixa o script principal com tratamento de erros
    curl -sSL https://raw.githubusercontent.com/leandoo/lara/main/bin/lara-pro -o $TEMP_SCRIPT || {
        echo -e "${RED}Falha ao baixar o instalador${NC}"
        exit 1
    }

    # Configura permissões automaticamente
    chmod +x $TEMP_SCRIPT || {
        echo -e "${RED}Falha ao configurar permissões${NC}"
        exit 1
    }

    # Instala dependências
    install_dependencies

    # Diretório de instalação
    INSTALL_DIR="$HOME/.lara-pro"
    
    # Clona o repositório (ou atualiza se já existir)
    if [ -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}Atualizando instalação existente...${NC}"
        cd "$INSTALL_DIR"
        git pull origin main || {
            echo -e "${RED}Falha ao atualizar o repositório${NC}"
            exit 1
        }
    else
        echo -e "${YELLOW}Baixando Lara Pro...${NC}"
        git clone https://github.com/leandoo/lara.git "$INSTALL_DIR" || {
            echo -e "${RED}Falha ao baixar o repositório${NC}"
            exit 1
        }
        cd "$INSTALL_DIR"
    fi

    # Instala dependências do projeto
    echo -e "${YELLOW}Instalando dependências do projeto...${NC}"
    npm install || {
        echo -e "${RED}Falha ao instalar dependências do projeto${NC}"
        exit 1
    }

    # Configura permissões automaticamente para todos os scripts
    find "$INSTALL_DIR/bin" -type f -exec chmod +x {} \;

    # Cria link simbólico global
    echo -e "${YELLOW}Configurando acesso global...${NC}"
    sudo ln -sf "$INSTALL_DIR/bin/lara-pro" /usr/local/bin/lara-pro || {
        echo -e "${YELLOW}Aviso: Não foi possível criar link global${NC}"
        echo -e "${YELLOW}Você pode executar diretamente com:${NC}"
        echo -e "${GREEN}$INSTALL_DIR/bin/lara-pro${NC}"
    }

    echo -e "${GREEN}\nInstalação concluída com sucesso!${NC}"
    echo -e "Execute o Lara Pro com: ${YELLOW}lara-pro${NC}"
    echo -e "Ou acesse o diretório: ${YELLOW}cd $INSTALL_DIR${NC}"
}

# Executa a instalação
main
