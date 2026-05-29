require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');

// 1. IMPORTACIÓN CORREGIDA: El nombre real de la clase es GoogleGenAI
const { GoogleGenAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

// Inicializar Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. INICIALIZACIÓN OFICIAL: Usando el constructor correcto
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// 1. RUTA PARA REGISTRAR UN USUARIO NUEVO
app.post('/api/registrar', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

    try {
        const contrasenaEncriptada = await bcrypt.hash(contrasena, SALT_ROUNDS);

        const { data, error } = await supabase
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

// 2. RUTA PARA INICIAR SESIÓN (LOGIN)
app.post('/api/login', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Campos incompletos' });

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

// 3. RUTA DEL ASISTENTE IA (Estrategia RAG Híbrida Avanzada con Gemini 1.5 Flash)
app.post('/api/preguntar', async (req, res) => {
    const { pregunta } = req.body;
    if (!pregunta) return res.status(400).json({ error: 'La pregunta es requerida' });

    try {
        let palabras = pregunta.toLowerCase().split(' ');

        let { data: contenidos, error } = await supabase
            .from('contenido_calculo')
            .select('tema, contenido_texto, contexto_formateado');

        if (error) throw error;

        let contextoEncontrado = "";
        let existeEnBD = false;

        if (contenidos && contenidos.length > 0) {
            let filtrados = contenidos.filter(c =>
                pregunta.toLowerCase().includes(c.tema.toLowerCase()) ||
                c.contenido_texto.toLowerCase().split(' ').some(p => palabras.includes(p) && p.length > 4)
            );

            if (filtrados.length > 0) {
                existeEnBD = true;
                contextoEncontrado = filtrados.map(c =>
                    `Tema: ${c.tema}\nExplicación: ${c.contenido_texto}\nFórmula/Ejemplo: ${c.contexto_formateado || ''}`
                ).join('\n\n');
            }
        }

        let instruccionesIA = "";
        if (existeEnBD) {
            instruccionesIA = `
            Eres un tutor experto en Cálculo 1 para la UMG. 
            Se ha encontrado información relevante directamente en la base de datos universitaria de Supabase.
            Usa el siguiente contexto local de forma prioritaria para responder y estructurar tu explicación:
            
            ${contextoEncontrado}`;
        } else {
            instruccionesIA = `
            Eres un tutor experto en Cálculo 1 para la UMG. 
            CRÍTICO: El tema solicitado por el alumno NO se encuentra registrado en la base de datos local de Supabase.
            Debes responder su duda usando tu conocimiento general sobre Cálculo 1 de forma clara y precisa, pero es OBLIGATORIO que la primerísima línea de tu respuesta sea EXACTAMENTE este aviso en negrita:
            "**[Aviso: Esta respuesta fue generada usando el conocimiento general de la IA, ya que el tema específico no se encuentra mapeado en la base de datos de la universidad].**"
            Luego de colocar ese aviso, dejas un salto de línea y procedes a responder su consulta detalladamente.`;
        }

        const promptCompleto = `${instruccionesIA}\n\nPregunta del estudiante: ${pregunta}\nRespuesta educativa estructurada:`;

        // Llamar al modelo usando los métodos correctos de la instancia ai
        const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(promptCompleto);
        const respuestaIA = result.response.text();

        if (!respuestaIA) {
            return res.json({ respuesta: "La IA no pudo procesar la respuesta en este momento. Inténtalo de nuevo." });
        }

        res.json({ respuesta: respuestaIA });

    } catch (err) {
        console.error("Error detallado en la ruta /api/preguntar:", err);
        res.status(500).json({ error: 'Error interno en el servidor al procesar la consulta' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo de forma segura en el puerto ${PORT}`);
});