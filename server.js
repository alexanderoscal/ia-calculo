require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { Groq } = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    db: { schema: 'public' }
});

// Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// ------------------ REGISTRO (igual) ------------------
app.post('/api/registrar', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    try {
        const contrasenaEncriptada = await bcrypt.hash(contrasena, SALT_ROUNDS);
        const { error } = await supabase
            .from('usuarios_calculo')
            .insert([{ usuario: usuario.toLowerCase().trim(), contrasena: contrasenaEncriptada }]);
        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'El usuario ya existe' });
            throw error;
        }
        res.json({ mensaje: 'Usuario creado con éxito' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// ------------------ LOGIN (igual) ------------------
app.post('/api/login', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Campos incompletos' });
    try {
        const { data: user, error } = await supabase
            .from('usuarios_calculo')
            .select('*')
            .eq('usuario', usuario.toLowerCase().trim())
            .single();
        if (error || !user) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        const coincide = await bcrypt.compare(contrasena, user.contrasena);
        if (!coincide) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        res.json({ usuario: user.usuario });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error en el inicio de sesión' });
    }
});

// ------------------ ASISTENTE IA con Groq (RAG) ------------------
app.post('/api/preguntar', async (req, res) => {
    const { pregunta } = req.body;
    if (!pregunta) return res.status(400).json({ error: 'La pregunta es requerida' });

    try {
        // 1. Buscar contexto en Supabase (igual que antes)
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

        // 2. Llamar a Groq con Llama 3.3 70B (gratuito y potente)
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: instruccionesIA },
                { role: "user", content: pregunta }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.5,
            max_tokens: 1500,
        });

        const respuestaIA = chatCompletion.choices[0]?.message?.content || "Lo siento, no pude generar una respuesta.";
        res.json({ respuesta: respuestaIA });

    } catch (err) {
        console.error("Error en /api/preguntar:", err);
        let mensajeError = "❌ Error interno al procesar la consulta.";
        if (err.status === 429) {
            mensajeError = "🚫 Has alcanzado el límite gratuito de Groq por minuto. Espera unos segundos y vuelve a intentarlo.";
        } else if (err.message?.includes("API key")) {
            mensajeError = "🔑 Clave de API de Groq inválida o no configurada. Verifica la variable GROQ_API_KEY en Render.";
        } else {
            mensajeError = `⚠️ Error: ${err.message || err}`;
        }
        res.status(500).json({ error: mensajeError });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT} usando Groq (Llama 3.3 70B)`);
});