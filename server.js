require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    db: { schema: 'public' }
});

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static('public'));

// ------------------ REGISTRO ------------------
app.post('/api/registrar', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    try {
        const contrasenaEncriptada = await bcrypt.hash(contrasena, SALT_ROUNDS);
        const { error } = await supabase
            .from('usuarios_calculo')
            .insert([{ usuario: usuario.toLowerCase().trim(), contrasena: contrasenaEncriptada }]);
        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ error: 'El usuario ya existe' });
            }
            throw error;
        }
        res.json({ mensaje: 'Usuario creado con éxito' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// ------------------ LOGIN ------------------
app.post('/api/login', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) {
        return res.status(400).json({ error: 'Campos incompletos' });
    }
    try {
        const { data: user, error } = await supabase
            .from('usuarios_calculo')
            .select('*')
            .eq('usuario', usuario.toLowerCase().trim())
            .single();
        if (error || !user) {
            return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        }
        const coincide = await bcrypt.compare(contrasena, user.contrasena);
        if (!coincide) {
            return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        }
        res.json({ usuario: user.usuario });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error en el inicio de sesión' });
    }
});

// ------------------ ASISTENTE IA con modelos alternativos ------------------
// Lista de modelos a probar en orden (el primero que funcione se usará)
const MODELOS_GEMINI = ["gemini-pro", "gemini-1.5-pro", "gemini-2.0-flash"];

async function generarRespuestaConGemini(prompt, intentos = 0) {
    if (intentos >= MODELOS_GEMINI.length) {
        throw new Error("No hay modelos disponibles. Verifica tu API key o la conectividad.");
    }
    const modelName = MODELOS_GEMINI[intentos];
    try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const respuesta = result.response.text();
        if (!respuesta) throw new Error("Respuesta vacía del modelo");
        return { respuesta, modeloUsado: modelName };
    } catch (err) {
        console.warn(`Modelo ${modelName} falló: ${err.message}`);
        // Si el error es 404 o modelo no encontrado, intentar con el siguiente
        if (err.status === 404 || err.message?.includes("not found")) {
            return generarRespuestaConGemini(prompt, intentos + 1);
        }
        throw err; // Otro tipo de error (429, 401, etc.) se lanza directamente
    }
}

app.post('/api/preguntar', async (req, res) => {
    const { pregunta } = req.body;
    if (!pregunta) {
        return res.status(400).json({ error: 'La pregunta es requerida' });
    }

    try {
        // 1. Buscar contexto en Supabase (RAG)
        const palabras = pregunta.toLowerCase().split(/\s+/);
        const { data: contenidos, error } = await supabase
            .from('contenido_calculo')
            .select('tema, contenido_texto, contexto_formateado');
        if (error) throw error;

        let contextoEncontrado = "";
        let existeEnBD = false;

        if (contenidos && contenidos.length) {
            const filtrados = contenidos.filter(c =>
                pregunta.toLowerCase().includes(c.tema.toLowerCase()) ||
                c.contenido_texto.toLowerCase().split(/\s+/).some(p => palabras.includes(p) && p.length > 4)
            );
            if (filtrados.length) {
                existeEnBD = true;
                contextoEncontrado = filtrados.map(c =>
                    `Tema: ${c.tema}\nExplicación: ${c.contenido_texto}\nFórmula/Ejemplo: ${c.contexto_formateado || ''}`
                ).join('\n\n');
            }
        }

        let instruccionesIA = "";
        if (existeEnBD) {
            instruccionesIA = `Eres un tutor experto en Cálculo 1 para la UMG. Usa el siguiente contexto oficial de la base de datos universitaria para responder:\n\n${contextoEncontrado}`;
        } else {
            instruccionesIA = `Eres un tutor experto en Cálculo 1 para la UMG.\n**IMPORTANTE**: El tema NO está en la base de datos local.\nTu respuesta DEBE comenzar con:\n"**[Aviso: Esta respuesta fue generada usando el conocimiento general de la IA, ya que el tema específico no se encuentra mapeado en la base de datos de la universidad].**"\nLuego salta una línea y responde normalmente.`;
        }

        const promptCompleto = `${instruccionesIA}\n\nPregunta del estudiante: ${pregunta}\nRespuesta educativa estructurada:`;

        // 2. Llamar a Gemini con fallback automático de modelos
        const { respuesta, modeloUsado } = await generarRespuestaConGemini(promptCompleto);

        // Opcional: agregar un pequeño pie de página indicando el modelo usado (para depuración)
        const respuestaFinal = `${respuesta}\n\n---\n*🤖 Modelo usado: ${modeloUsado}*`;

        res.json({ respuesta: respuestaFinal });
    } catch (err) {
        console.error("Error en /api/preguntar:", err);

        // Mensajes de error claros según el tipo de fallo
        let mensajeError = "Error interno al procesar la consulta.";
        if (err.status === 429) {
            mensajeError = "🚫 Límite de cuota excedido. Por favor, espera un momento o revisa tu plan de facturación en Google AI Studio. (Error 429)";
        } else if (err.status === 401 || err.message?.includes("API key")) {
            mensajeError = "🔑 Clave de API inválida o no configurada. Verifica tu variable GEMINI_API_KEY en Render.";
        } else if (err.message?.includes("network") || err.message?.includes("fetch")) {
            mensajeError = "🌐 Problema de red. No se pudo conectar con la API de Gemini.";
        } else if (err.message?.includes("not found") || err.status === 404) {
            mensajeError = "🧠 Modelo de IA no disponible temporalmente. Inténtalo más tarde.";
        } else {
            mensajeError = `❌ Error inesperado: ${err.message || err}`;
        }

        res.status(500).json({ error: mensajeError });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});